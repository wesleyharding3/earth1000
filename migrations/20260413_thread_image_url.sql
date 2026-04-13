-- Add image_url column to story_threads for admin-set hero image override
ALTER TABLE story_threads ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT NULL;
