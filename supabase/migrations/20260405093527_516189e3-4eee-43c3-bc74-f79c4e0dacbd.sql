
ALTER TABLE public.scheduled_posts 
ADD COLUMN IF NOT EXISTS publish_results jsonb DEFAULT '{}'::jsonb;
