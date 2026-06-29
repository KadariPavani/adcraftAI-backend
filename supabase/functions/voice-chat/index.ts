import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Msg { role: "user" | "assistant" | "system"; content: string; }

interface RequestBody {
  messages: Msg[];
  context: {
    hasImage: boolean;
    productNote: string;
    lang: "en-IN" | "hi-IN";
    stage: "gathering" | "generated" | "saved";
  };
}

interface AIResponse {
  reply: string;
  action: "ask_photo" | "ask_details" | "ready_to_generate" | "ready_to_save" | "saved" | "continue";
  extracted?: { productNote?: string };
}

function systemPromptFor(ctx: RequestBody["context"]): string {
  const langInstruction = ctx.lang === "hi-IN"
    ? "Reply in simple Hindi using Latin script (e.g., 'Namaste! Aapke product ki photo add karein.'). Keep it warm and friendly."
    : "Reply in simple, friendly Indian English. Be warm, encouraging, and conversational.";

  const stageInstruction = ctx.stage === "generated"
    ? "The AI listing has been generated and is now shown to the user. Briefly present it and ask if they want to save it to their library. If they confirm, set action='ready_to_save'. If they want changes, set action='ask_details' and ask what to change."
    : ctx.stage === "saved"
    ? "The product has been saved. Congratulate them warmly and tell them they can view it in their library or create another. Set action='saved'."
    : `You are gathering info to create a product listing. The user ${ctx.hasImage ? "HAS already uploaded a photo" : "has NOT uploaded a photo yet — gently encourage them to add one but don't insist"}. Current notes from user: ${ctx.productNote ? `"${ctx.productNote}"` : "(none yet)"}. When you have enough info (product name + what it is + 1-2 details), set action='ready_to_generate' and combine everything into a single 'extracted.productNote' string that captures all important details.`;

  return `You are AdCraft AI's voice assistant — a friendly conversational helper for Indian artisans and small-business creators who want to sell their handmade products online.

${langInstruction}

CRITICAL RULES:
- Replies will be spoken aloud by a TTS engine. Keep each reply SHORT — ideally 1 sentence, maximum 2. No lists, no markdown, no emojis.
- Speak naturally like a helpful neighbor, not a chatbot. Don't say "I am an AI" or similar.
- Ask one question at a time.
- Never include phone numbers, URLs, or technical jargon.

${stageInstruction}

ALWAYS respond as valid JSON with this exact shape:
{
  "reply": "your short spoken reply",
  "action": "ask_photo" | "ask_details" | "ready_to_generate" | "ready_to_save" | "saved" | "continue",
  "extracted": { "productNote": "..." }
}

Actions guide:
- "ask_photo" — you want them to upload a photo
- "ask_details" — you want them to describe the product more
- "ready_to_generate" — you have enough info; include extracted.productNote with the full combined description
- "ready_to_save" — user confirmed they want to save the generated listing
- "saved" — confirm save was successful
- "continue" — generic continue, no special UI action`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as RequestBody;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const messages: Msg[] = [
      { role: "system", content: systemPromptFor(body.context) },
      ...body.messages.slice(-12), // keep window small for cost + latency
    ];

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages,
        response_format: { type: "json_object" },
        temperature: 0.6,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("AI Gateway error:", response.status, errText);
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ reply: "Sorry, I'm getting too many requests. Try again in a moment.", action: "continue" } satisfies AIResponse),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      throw new Error(`AI Gateway error: ${response.status}`);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "";

    let parsed: AIResponse;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { reply: raw.slice(0, 300) || "Sorry, could you say that again?", action: "continue" };
    }

    // Light safety: clamp reply length so TTS doesn't run forever
    if (parsed.reply && parsed.reply.length > 400) parsed.reply = parsed.reply.slice(0, 400);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("voice-chat error:", err);
    return new Response(
      JSON.stringify({
        reply: "Sorry, something went wrong. Please try again.",
        action: "continue",
      } satisfies AIResponse),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
