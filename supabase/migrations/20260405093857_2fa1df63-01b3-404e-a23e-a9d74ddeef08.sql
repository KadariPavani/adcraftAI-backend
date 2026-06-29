
CREATE TABLE public.user_social_credentials (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  platform text NOT NULL,
  credential_key text NOT NULL,
  credential_value text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, credential_key)
);

ALTER TABLE public.user_social_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own credentials"
ON public.user_social_credentials FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create own credentials"
ON public.user_social_credentials FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own credentials"
ON public.user_social_credentials FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own credentials"
ON public.user_social_credentials FOR DELETE
USING (auth.uid() = user_id);

CREATE TRIGGER update_user_social_credentials_updated_at
BEFORE UPDATE ON public.user_social_credentials
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
