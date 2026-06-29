-- Add product_links table for shareable link-in-bio style pages
CREATE TABLE public.product_links (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  whatsapp_number TEXT,
  instagram_handle TEXT,
  marketplace_url TEXT,
  website_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.product_links ENABLE ROW LEVEL SECURITY;

-- Policies for product_links
CREATE POLICY "Users can view own product links"
ON public.product_links
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create product links"
ON public.product_links
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own product links"
ON public.product_links
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own product links"
ON public.product_links
FOR DELETE
USING (auth.uid() = user_id);

-- Allow public access to active product links (for shareable pages)
CREATE POLICY "Anyone can view active product links"
ON public.product_links
FOR SELECT
USING (is_active = true);

-- Add link_clicks table for UTM tracking
CREATE TABLE public.link_clicks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_link_id UUID NOT NULL REFERENCES public.product_links(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'direct',
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  referrer TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  clicked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.link_clicks ENABLE ROW LEVEL SECURITY;

-- Allow inserting clicks without auth (for tracking)
CREATE POLICY "Anyone can insert clicks"
ON public.link_clicks
FOR INSERT
WITH CHECK (true);

-- Users can view clicks for their own product links
CREATE POLICY "Users can view own link clicks"
ON public.link_clicks
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.product_links pl
    WHERE pl.id = link_clicks.product_link_id
    AND pl.user_id = auth.uid()
  )
);

-- Add enhanced_image_url column to products table
ALTER TABLE public.products
ADD COLUMN enhanced_image_url TEXT;

-- Create trigger for updated_at on product_links
CREATE TRIGGER update_product_links_updated_at
BEFORE UPDATE ON public.product_links
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();