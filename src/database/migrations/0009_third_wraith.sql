CREATE TABLE "organization_onboarding_answers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"question_id" bigint NOT NULL,
	"question_prompt" text NOT NULL,
	"question_type" text NOT NULL,
	"question_version" integer DEFAULT 1 NOT NULL,
	"answer" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_onboarding_questions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"prompt" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"options" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_onboarding_answers" ADD CONSTRAINT "organization_onboarding_answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_onboarding_answers" ADD CONSTRAINT "organization_onboarding_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_onboarding_answers" ADD CONSTRAINT "organization_onboarding_answers_question_id_organization_onboarding_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."organization_onboarding_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_onboarding_questions" ADD CONSTRAINT "organization_onboarding_questions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_user_question_unq" ON "organization_onboarding_answers" USING btree ("organization_id","user_id","question_id");--> statement-breakpoint
CREATE INDEX "org_answers_user_idx" ON "organization_onboarding_answers" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "org_questions_org_idx" ON "organization_onboarding_questions" USING btree ("organization_id","active","sort_order");