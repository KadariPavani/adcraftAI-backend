import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const SECRET = "x9k2p7q4w8m1n6";
    const provided = url.searchParams.get("key") || req.headers.get("x-dash-key");
    if (provided !== SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") || "7")));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Pull recent events (cap to keep things sane)
    const { data: events, error } = await supabase
      .from("analytics_events")
      .select("id, session_id, user_id, event_name, page, properties, referrer, duration_ms, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(10000);
    if (error) throw error;

    // Aggregate
    const byEvent: Record<string, number> = {};
    const byPage: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    const sessions = new Set<string>();
    const users = new Set<string>();
    const clickTexts: Record<string, number> = {};
    let logins = 0, signups = 0, productCreated = 0, imageEnhanced = 0, imageEnhanceFailed = 0;
    let campaignsCreated = 0, postsPublished = 0, voiceStarted = 0;
    const pageDurations: Record<string, number[]> = {};

    for (const e of events || []) {
      byEvent[e.event_name] = (byEvent[e.event_name] || 0) + 1;
      if (e.page) byPage[e.page] = (byPage[e.page] || 0) + 1;
      const day = (e.created_at as string).slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
      if (e.session_id) sessions.add(e.session_id);
      if (e.user_id) users.add(e.user_id);

      if (e.event_name === "click") {
        const txt = (e.properties as any)?.text || (e.properties as any)?.aria || "(unlabeled)";
        clickTexts[txt] = (clickTexts[txt] || 0) + 1;
      }
      if (e.event_name === "auth_login") logins++;
      if (e.event_name === "auth_signup") signups++;
      if (e.event_name === "product_created") productCreated++;
      if (e.event_name === "image_enhanced") imageEnhanced++;
      if (e.event_name === "image_enhance_failed") imageEnhanceFailed++;
      if (e.event_name === "campaign_created") campaignsCreated++;
      if (e.event_name === "post_published") postsPublished++;
      if (e.event_name === "voice_mode_started") voiceStarted++;

      if (e.event_name === "page_leave" && e.duration_ms && e.page) {
        (pageDurations[e.page] = pageDurations[e.page] || []).push(e.duration_ms);
      }
    }

    const avgDurations: Record<string, number> = {};
    for (const [k, arr] of Object.entries(pageDurations)) {
      avgDurations[k] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    }

    const topClicks = Object.entries(clickTexts)
      .sort((a, b) => b[1] - a[1]).slice(0, 30)
      .map(([label, count]) => ({ label, count }));

    const recent = (events || []).slice(0, 200);

    return new Response(JSON.stringify({
      range_days: days,
      totals: {
        events: events?.length || 0,
        sessions: sessions.size,
        users: users.size,
        logins, signups, productCreated, imageEnhanced, imageEnhanceFailed,
        campaignsCreated, postsPublished, voiceStarted,
      },
      byEvent, byPage, byDay, avgPageMs: avgDurations,
      topClicks,
      recent,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
