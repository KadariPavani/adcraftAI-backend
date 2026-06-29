import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PLATFORM_FIELDS: Record<string, string[]> = {
  amazon: [
    "product_title",            // <= 200 chars, brand + product + key feature
    "brand",
    "manufacturer",
    "bullet_points",            // 5 SEO bullets, each <= 250 chars
    "product_description",      // 2000 chars rich
    "search_terms",             // backend keywords, comma sep, <= 250 chars total
    "category_path",            // suggested
    "item_type_keyword",
    "country_of_origin",
    "package_quantity",
  ],
  flipkart: [
    "product_title",            // <= 80 chars
    "brand",
    "key_features",             // bullets list
    "description",              // long
    "search_keywords",          // comma separated
    "category",
    "subcategory",
    "color",
    "size",
    "country_of_origin",
  ],
  meesho: [
    "product_name",             // <= 60 chars
    "short_description",
    "long_description",
    "category",
    "subcategory",
    "tags",                     // up to 10
    "highlights",               // 3-5 bullets
    "ideal_for",
    "country_of_origin",
  ],
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { platforms, productInfo, features, productImageUrl, brandName } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const validPlatforms = (platforms || []).filter((p: string) => PLATFORM_FIELDS[p]);
    if (validPlatforms.length === 0) {
      return new Response(JSON.stringify({ error: "No valid platforms specified" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fields that should be arrays of strings (bullets/tags). Everything else is a plain string.
    const ARRAY_FIELDS = new Set([
      "bullet_points", "key_features", "highlights", "tags",
    ]);

    const fieldSchema: Record<string, any> = {};
    for (const p of validPlatforms) {
      const props: Record<string, any> = {};
      for (const f of PLATFORM_FIELDS[p]) {
        props[f] = ARRAY_FIELDS.has(f)
          ? { type: "array", items: { type: "string" } }
          : { type: "string" };
      }
      fieldSchema[p] = {
        type: "object",
        properties: props,
        required: PLATFORM_FIELDS[p],
        additionalProperties: false,
      };
    }

    const systemPrompt = `You are an expert ecommerce listing copywriter for India focused on SEO and conversions.
For each requested platform, generate ALL of its required fields. Strictly follow each platform's character limits and conventions:
- Amazon India: title <=200 chars (Brand + Product + Key Feature + Size/Color), 5 bullet_points each <=250 chars (benefit-led), product_description rich and 1500-2000 chars, search_terms is a single comma-separated string of backend keywords <=250 chars total.
- Flipkart: product_title <=80 chars, key_features as 4-6 short bullets, description detailed.
- Meesho: product_name <=60 chars (very short, keyword-first), 3-5 highlights, tags as array.
Use the user's product details and features. Be specific, factual, never invent measurements not provided. Be SEO optimized using natural high-intent keywords.`;

    const userPrompt = `Brand name: "${brandName || "Unbranded"}"
Use this exact brand name in the brand/manufacturer fields and naturally in titles where appropriate.

Product details from creator:
"""${productInfo || ""}"""

Key features / specs from creator:
"""${features || ""}"""

Generate listings for: ${validPlatforms.join(", ")}.`;

    const tools = [{
      type: "function",
      function: {
        name: "emit_listings",
        description: "Return the platform-specific ecommerce listings.",
        parameters: {
          type: "object",
          properties: fieldSchema,
          required: validPlatforms,
          additionalProperties: false,
        },
      },
    }];

    const messages: any[] = [
      { role: "system", content: systemPrompt },
    ];
    if (productImageUrl) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: productImageUrl } },
        ],
      });
    } else {
      messages.push({ role: "user", content: userPrompt });
    }

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages,
        tools,
        tool_choice: { type: "function", function: { name: "emit_listings" } },
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      console.error("AI error", resp.status, t);
      if (resp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again shortly." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (resp.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add funds." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error(`AI gateway error ${resp.status}`);
    }

    const data = await resp.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : null;
    if (!args) throw new Error("AI did not return structured listings");

    return new Response(JSON.stringify({ listings: args, fields: PLATFORM_FIELDS }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("generate-ecommerce-listing error:", err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
