import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PublishRequest {
  postId: string;
  platform: string;
}

interface PublishResult {
  platform: string;
  success: boolean;
  platformPostId?: string;
  error?: string;
  publishedAt?: string;
}

async function getUserCredential(supabase: any, userId: string, platform: string, key: string): Promise<string | null> {
  const { data } = await supabase
    .from('user_social_credentials')
    .select('credential_value')
    .eq('user_id', userId)
    .eq('platform', platform)
    .eq('credential_key', key)
    .single();
  return data?.credential_value || null;
}

// Read any image URL form (data:, https:, http: that we can reach) into raw bytes.
// Rejects blob:/localhost which can never be loaded server-side.
async function readImageBytes(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!url) throw new Error('No image URL provided');
  if (url.startsWith('blob:') || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
    throw new Error(`Image source not reachable from server (${url.slice(0, 60)}…). Re-upload before publishing.`);
  }
  if (url.startsWith('data:')) {
    const match = url.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!match) throw new Error('Unsupported image data URI (expected base64 image)');
    const contentType = match[1];
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    console.log(`[readImageBytes] data URI ${contentType}, ${bytes.length} bytes`);
    return { bytes, contentType };
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch source image (HTTP ${res.status}): ${url.slice(0, 80)}`);
    const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const bytes = new Uint8Array(await res.arrayBuffer());
    console.log(`[readImageBytes] fetched ${contentType}, ${bytes.length} bytes ← ${url.slice(0, 80)}`);
    return { bytes, contentType };
  }
  throw new Error(`Unrecognized image URL scheme: ${url.slice(0, 40)}…`);
}

// Upload bytes to the Page as an UNPUBLISHED photo. Returns the FB-CDN URL
// (which IG trusts unconditionally) plus the photo id so we can clean it up later.
async function uploadAsUnpublishedPhoto(
  pageAccessToken: string,
  pageId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ photoId: string; imageUrl: string }> {
  const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg').split('+')[0];
  const form = new FormData();
  form.append('source', new Blob([bytes], { type: contentType }), `image.${ext}`);
  form.append('published', 'false');
  form.append('access_token', pageAccessToken);

  const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photos`, { method: 'POST', body: form });
  const data = await res.json();
  const err = fbError(data);
  if (err) throw new Error('Photo upload (unpublished) failed: ' + err);
  if (!data.id) throw new Error('Photo upload returned no id');

  const infoRes = await fetch(
    `https://graph.facebook.com/v21.0/${data.id}?fields=images&access_token=${encodeURIComponent(pageAccessToken)}`,
  );
  const infoData = await infoRes.json();
  const infoErr = fbError(infoData);
  if (infoErr) throw new Error('Photo info lookup failed: ' + infoErr);
  const images: Array<{ source: string; width?: number; height?: number }> = infoData.images || [];
  if (!images.length) throw new Error('Photo has no image variants');
  const largest = images.reduce((a, b) => ((b.height || 0) > (a.height || 0) ? b : a), images[0]);
  console.log(`[uploadAsUnpublishedPhoto] photo=${data.id} url=${largest.source.slice(0, 80)}…`);
  return { photoId: data.id, imageUrl: largest.source };
}

async function deletePhoto(token: string, photoId: string): Promise<void> {
  // Best-effort cleanup; failure here is non-fatal.
  try {
    await fetch(`https://graph.facebook.com/v21.0/${photoId}?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    console.log(`[deletePhoto] cleaned up unpublished photo ${photoId}`);
  } catch (e) {
    console.warn(`[deletePhoto] cleanup failed for ${photoId}:`, e);
  }
}

const PUBLISH_POST_VERSION = 'v4-fb-relay';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  console.log(`[publish-post ${PUBLISH_POST_VERSION}] invoked`);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    // User-scoped client for auth check
    const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Service role client to read credentials (bypasses RLS for the edge function context)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const { postId, platform }: PublishRequest = await req.json();

    if (!postId || !platform) {
      return new Response(JSON.stringify({ error: 'postId and platform are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fetch the post (use user client to respect RLS)
    const { data: post, error: postError } = await supabaseUser
      .from('scheduled_posts')
      .select('*')
      .eq('id', postId)
      .eq('user_id', user.id)
      .single();

    if (postError || !post) {
      return new Response(JSON.stringify({ error: 'Post not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Helper to get user's credentials from DB
    const getCred = (credPlatform: string, key: string) => getUserCredential(supabaseAdmin, user.id, credPlatform, key);

    let result: PublishResult;

    if (platform === 'instagram') {
      result = await publishToInstagram(post, getCred);
    } else if (platform === 'facebook') {
      result = await publishToFacebook(post, getCred);
    } else if (platform === 'whatsapp') {
      result = await publishToWhatsApp(post, getCred);
    } else {
      return new Response(JSON.stringify({ error: `Unsupported platform: ${platform}` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Update publish_results
    const existingResults = (post.publish_results as Record<string, unknown>) || {};
    const updatedResults = { ...existingResults, [platform]: result };

    const allPlatforms = post.platforms as string[];
    const allPublished = allPlatforms.every((p: string) => {
      const r = updatedResults[p] as PublishResult | undefined;
      return r?.success === true;
    });

    const updateData: Record<string, unknown> = { publish_results: updatedResults };

    if (allPublished) {
      updateData.status = 'published';
      updateData.published_at = new Date().toISOString();
    } else if (result.success) {
      updateData.status = 'published';
      if (!post.published_at) updateData.published_at = new Date().toISOString();
    }

    await supabaseUser
      .from('scheduled_posts')
      .update(updateData)
      .eq('id', postId);

    if (result.success) {
      await supabaseUser.from('post_analytics').insert({
        post_id: postId,
        metric_type: 'publish',
        metric_value: 1,
        metadata: { platform, platformPostId: result.platformPostId },
      });
    }

    return new Response(JSON.stringify({ result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Publish error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

type GetCred = (platform: string, key: string) => Promise<string | null>;

function fbError(data: any): string | null {
  if (!data?.error) return null;
  const e = data.error;
  const userMsg = e.error_user_msg || e.error_user_title;
  const detail = userMsg ? `${e.message} — ${userMsg}` : e.message;
  return `[${e.code}${e.error_subcode ? '/' + e.error_subcode : ''}] ${detail}${e.fbtrace_id ? ' (trace ' + e.fbtrace_id + ')' : ''}`;
}

async function publishToInstagram(post: any, getCred: GetCred): Promise<PublishResult> {
  const tag = `[ver=${PUBLISH_POST_VERSION}]`;
  const wrap = (msg: string, url?: string) => `${tag} ${msg}${url ? ` | image=${url}` : ''}`;

  const accessToken = await getCred('meta', 'page_access_token');
  const igAccountId = await getCred('meta', 'instagram_business_account_id');
  const fbPageId = await getCred('meta', 'facebook_page_id');

  if (!accessToken || !igAccountId) {
    return { platform: 'instagram', success: false, error: wrap('Instagram credentials missing (Page Access Token + Instagram Business Account ID required).') };
  }
  if (!fbPageId) {
    return { platform: 'instagram', success: false, error: wrap('Facebook Page ID is required for Instagram publishing (used to host the image on Meta CDN). Add it in Social Settings.') };
  }

  let imageUrl: string | undefined;
  let photoId: string | undefined;

  try {
    const caption = buildCaption(post);
    const rawImageUrl = post.image_urls?.[0];
    if (!rawImageUrl) return { platform: 'instagram', success: false, error: wrap('Instagram requires at least one image.') };

    if (caption.length > 2200) return { platform: 'instagram', success: false, error: wrap(`Caption length ${caption.length} exceeds Instagram limit of 2200.`) };
    const hashtagCount = (caption.match(/#\w+/g) || []).length;
    if (hashtagCount > 30) return { platform: 'instagram', success: false, error: wrap(`Hashtag count ${hashtagCount} exceeds Instagram limit of 30.`) };

    // 1) Read image bytes from any source (data:, https:, http:)
    const { bytes, contentType } = await readImageBytes(rawImageUrl);

    // 2) Upload to Facebook Page as unpublished → get Meta-CDN URL that IG trusts
    const uploaded = await uploadAsUnpublishedPhoto(accessToken, fbPageId, bytes, contentType);
    photoId = uploaded.photoId;
    imageUrl = uploaded.imageUrl;

    // 3) Create IG media container with that URL
    console.log('[Instagram] POST /media with FB-CDN image url');
    const createRes = await fetch(`https://graph.facebook.com/v21.0/${igAccountId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, caption, access_token: accessToken }),
    });
    const createData = await createRes.json();
    console.log('[Instagram] /media response:', JSON.stringify(createData));
    const createErr = fbError(createData);
    if (createErr) return { platform: 'instagram', success: false, error: wrap('Create container failed: ' + createErr, imageUrl) };
    if (!createData.id) return { platform: 'instagram', success: false, error: wrap('Create container returned no id', imageUrl) };

    // 4) Poll container status
    const creationId = createData.id;
    let status = 'IN_PROGRESS';
    for (let i = 0; i < 10 && status === 'IN_PROGRESS'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch(
        `https://graph.facebook.com/v21.0/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`,
      );
      const statusData = await statusRes.json();
      const statusErr = fbError(statusData);
      if (statusErr) return { platform: 'instagram', success: false, error: wrap('Status check failed: ' + statusErr, imageUrl) };
      status = statusData.status_code || 'IN_PROGRESS';
      if (status === 'ERROR' || status === 'EXPIRED') {
        return { platform: 'instagram', success: false, error: wrap(`Container ${status}: ${statusData.status || 'image rejected by IG'}`, imageUrl) };
      }
    }
    if (status !== 'FINISHED') {
      return { platform: 'instagram', success: false, error: wrap(`Container not ready after 20s (status=${status}).`, imageUrl) };
    }

    // 5) Publish
    const publishRes = await fetch(`https://graph.facebook.com/v21.0/${igAccountId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: creationId, access_token: accessToken }),
    });
    const publishData = await publishRes.json();
    const publishErr = fbError(publishData);
    if (publishErr) return { platform: 'instagram', success: false, error: wrap('Publish failed: ' + publishErr, imageUrl) };
    if (!publishData.id) return { platform: 'instagram', success: false, error: wrap('Publish returned no id', imageUrl) };

    return { platform: 'instagram', success: true, platformPostId: publishData.id, publishedAt: new Date().toISOString() };
  } catch (err) {
    return { platform: 'instagram', success: false, error: wrap(err instanceof Error ? err.message : 'Unknown error', imageUrl) };
  } finally {
    if (photoId) await deletePhoto(accessToken, photoId);
  }
}

async function publishToFacebook(post: any, getCred: GetCred): Promise<PublishResult> {
  const tag = `[ver=${PUBLISH_POST_VERSION}]`;
  const wrap = (msg: string) => `${tag} ${msg}`;

  const accessToken = await getCred('meta', 'page_access_token');
  const pageId = await getCred('meta', 'facebook_page_id');

  if (!accessToken || !pageId) {
    return { platform: 'facebook', success: false, error: wrap('Facebook credentials missing (Page Access Token + Facebook Page ID).') };
  }

  try {
    const message = buildCaption(post);
    const rawImageUrl = post.image_urls?.[0];

    let res: Response;
    if (rawImageUrl) {
      // Upload bytes directly — no URL, no hosting middleman.
      const { bytes, contentType } = await readImageBytes(rawImageUrl);
      const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg').split('+')[0];
      const form = new FormData();
      form.append('source', new Blob([bytes], { type: contentType }), `image.${ext}`);
      form.append('message', message);
      form.append('access_token', accessToken);
      res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photos`, { method: 'POST', body: form });
    } else {
      const body: Record<string, string> = { message, access_token: accessToken };
      if (post.link_url) body.link = post.link_url;
      res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    const data = await res.json();
    console.log('[Facebook] response:', JSON.stringify(data));
    const fbErr = fbError(data);
    if (fbErr) return { platform: 'facebook', success: false, error: wrap(fbErr) };
    return { platform: 'facebook', success: true, platformPostId: data.id || data.post_id, publishedAt: new Date().toISOString() };
  } catch (err) {
    return { platform: 'facebook', success: false, error: wrap(err instanceof Error ? err.message : 'Unknown error') };
  }
}

async function publishToWhatsApp(post: any, getCred: GetCred): Promise<PublishResult> {
  const accessToken = await getCred('whatsapp', 'access_token');
  const phoneNumberId = await getCred('whatsapp', 'phone_number_id');

  if (!accessToken || !phoneNumberId) {
    return {
      platform: 'whatsapp',
      success: false,
      error: 'WhatsApp credentials not configured. Go to Social Settings → API Settings to add your WhatsApp API keys.',
    };
  }

  try {
    const message = buildCaption(post);

    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', type: 'text', text: { body: message } }),
    });

    const data = await res.json();
    const waErr = fbError(data);
    if (waErr) return { platform: 'whatsapp', success: false, error: waErr };

    return { platform: 'whatsapp', success: true, platformPostId: data.messages?.[0]?.id, publishedAt: new Date().toISOString() };
  } catch (err) {
    return { platform: 'whatsapp', success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

function buildCaption(post: any): string {
  let caption = post.caption || '';
  if (post.hashtags?.length > 0) caption += '\n\n' + post.hashtags.map((h: string) => `#${h}`).join(' ');
  if (post.link_url) caption += '\n\n🔗 ' + post.link_url;
  return caption;
}
