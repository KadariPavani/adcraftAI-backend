
-- Allow public to view products that have an active product link
CREATE POLICY "Public can view products with active links"
ON public.products
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM product_links pl 
    WHERE pl.product_id = products.id 
    AND pl.is_active = true
  )
);
