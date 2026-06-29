import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { productLinkId, utmSource, utmMedium, utmCampaign, referrer, source } = await req.json();

    if (!productLinkId) {
      throw new Error('Product link ID is required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get user agent from request headers
    const userAgent = req.headers.get('user-agent') || 'Unknown';
    
    // Generate a simple hash from IP (for privacy) - in production you'd want proper anonymization
    const forwarded = req.headers.get('x-forwarded-for');
    const ip = forwarded ? forwarded.split(',')[0] : 'unknown';
    const ipHash = btoa(ip).slice(0, 16); // Simple obfuscation

    console.log('Tracking click for product link:', productLinkId, 'Source:', source || utmSource);

    const { error } = await supabase
      .from('link_clicks')
      .insert({
        product_link_id: productLinkId,
        source: source || utmSource || 'direct',
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        referrer: referrer,
        user_agent: userAgent,
        ip_hash: ipHash,
      });

    if (error) {
      console.error('Error inserting click:', error);
      throw error;
    }

    console.log('Click tracked successfully');

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in track-click function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
