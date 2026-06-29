
-- Create product_collections table
CREATE TABLE public.product_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  whatsapp_number text,
  instagram_handle text,
  marketplace_url text,
  website_url text,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Create collection_products junction table
CREATE TABLE public.collection_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES public.product_collections(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  sort_order integer DEFAULT 0,
  UNIQUE(collection_id, product_id)
);

-- Enable RLS
ALTER TABLE public.product_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_products ENABLE ROW LEVEL SECURITY;

-- product_collections RLS
CREATE POLICY "Users can view own collections" ON public.product_collections FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Public can view active collections" ON public.product_collections FOR SELECT USING (is_active = true);
CREATE POLICY "Users can create collections" ON public.product_collections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own collections" ON public.product_collections FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own collections" ON public.product_collections FOR DELETE USING (auth.uid() = user_id);

-- collection_products RLS
CREATE POLICY "Users can manage own collection products" ON public.collection_products FOR ALL USING (
  EXISTS (SELECT 1 FROM public.product_collections pc WHERE pc.id = collection_products.collection_id AND pc.user_id = auth.uid())
);
CREATE POLICY "Public can view active collection products" ON public.collection_products FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.product_collections pc WHERE pc.id = collection_products.collection_id AND pc.is_active = true)
);

-- Updated_at trigger for collections
CREATE TRIGGER update_product_collections_updated_at
  BEFORE UPDATE ON public.product_collections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
