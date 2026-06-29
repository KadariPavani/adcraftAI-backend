
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS enhanced_image_urls TEXT[] DEFAULT '{}'::text[];
