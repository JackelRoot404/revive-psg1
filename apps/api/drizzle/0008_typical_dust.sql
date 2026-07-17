ALTER TYPE "public"."order_kind" ADD VALUE 'early_access';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'free_activated' BEFORE 'refunded';