-- Migration: Add is_hot column back to tokens table
-- Date: 2025-02-27

-- Add is_hot column to tokens table
ALTER TABLE public.tokens
ADD COLUMN IF NOT EXISTS is_hot BOOLEAN DEFAULT FALSE;

-- Update RLS policies for the is_hot column
GRANT ALL ON public.tokens TO authenticated;
GRANT ALL ON public.tokens TO service_role;
