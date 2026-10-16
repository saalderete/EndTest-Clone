-- TestHarvest schema: workspaces, roles, environments, encrypted secrets,
-- versioned tests, the run queue, schedules, events, artifacts, alerts,
-- audit and AI request logs. A new install starts empty; the first owner is
-- created with `npm run admin -- create-owner`.
--
-- Later schema changes go in new numbered files next to this one.

CREATE TABLE public.ai_requests (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    user_id character varying,
    kind text NOT NULL,
    model text NOT NULL,
    status text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cost_micro_usd bigint DEFAULT 0 NOT NULL,
    execution_id integer,
    case_id integer,
    result jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_requests_kind_check CHECK ((kind = ANY (ARRAY['case_draft'::text, 'failure_analysis'::text]))),
    CONSTRAINT ai_requests_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'error'::text, 'rejected'::text])))
);

CREATE SEQUENCE public.ai_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_requests_id_seq OWNED BY public.ai_requests.id;

CREATE TABLE public.artifacts (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    execution_id integer NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    step_index integer,
    kind text NOT NULL,
    storage_key text NOT NULL,
    content_type text NOT NULL,
    size_bytes integer NOT NULL,
    sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retention_until timestamp with time zone,
    CONSTRAINT artifacts_kind_check CHECK ((kind = ANY (ARRAY['screenshot'::text, 'trace'::text, 'video'::text, 'log'::text])))
);

CREATE SEQUENCE public.artifacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.artifacts_id_seq OWNED BY public.artifacts.id;

CREATE TABLE public.audit_events (
    id bigint NOT NULL,
    workspace_id integer,
    actor_user_id character varying,
    action text NOT NULL,
    target_type text,
    target_id text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    ai_involved boolean DEFAULT false NOT NULL,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.audit_events_id_seq OWNED BY public.audit_events.id;

CREATE TABLE public.case_versions (
    id integer NOT NULL,
    case_id integer NOT NULL,
    workspace_id integer NOT NULL,
    version integer NOT NULL,
    steps jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    note text,
    published_by character varying,
    published_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.case_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.case_versions_id_seq OWNED BY public.case_versions.id;

CREATE TABLE public.environments (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    name text NOT NULL,
    base_url text NOT NULL,
    allowed_hosts text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.environments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.environments_id_seq OWNED BY public.environments.id;

CREATE TABLE public.incidents (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    case_id integer NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    opened_by_execution_id integer,
    resolved_by_execution_id integer,
    consecutive_failures integer DEFAULT 1 NOT NULL,
    notified_at timestamp with time zone
);

CREATE SEQUENCE public.incidents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.incidents_id_seq OWNED BY public.incidents.id;

CREATE TABLE public.invitations (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    token_hash text NOT NULL,
    invited_by character varying,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invitations_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'editor'::text, 'runner'::text, 'viewer'::text])))
);

CREATE SEQUENCE public.invitations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.invitations_id_seq OWNED BY public.invitations.id;

CREATE TABLE public.memberships (
    workspace_id integer NOT NULL,
    user_id character varying NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'editor'::text, 'runner'::text, 'viewer'::text])))
);

CREATE TABLE public.notification_deliveries (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    rule_id integer,
    incident_id integer,
    execution_id integer,
    channel text NOT NULL,
    target_masked text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    error text,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT notification_deliveries_kind_check CHECK ((kind = ANY (ARRAY['failure'::text, 'recovery'::text, 'test'::text, 'invite'::text, 'password'::text]))),
    CONSTRAINT notification_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'suppressed'::text])))
);

CREATE SEQUENCE public.notification_deliveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_deliveries_id_seq OWNED BY public.notification_deliveries.id;

CREATE TABLE public.notification_rules (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    case_id integer,
    suite_id integer,
    channel text NOT NULL,
    target text NOT NULL,
    on_failure boolean DEFAULT true NOT NULL,
    on_recovery boolean DEFAULT true NOT NULL,
    failure_threshold integer DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_rules_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'webhook'::text]))),
    CONSTRAINT notification_rules_failure_threshold_check CHECK (((failure_threshold >= 1) AND (failure_threshold <= 20)))
);

CREATE SEQUENCE public.notification_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_rules_id_seq OWNED BY public.notification_rules.id;

CREATE TABLE public.password_tokens (
    id integer NOT NULL,
    user_id character varying NOT NULL,
    token_hash text NOT NULL,
    purpose text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT password_tokens_purpose_check CHECK ((purpose = ANY (ARRAY['set_password'::text, 'reset_password'::text, 'verify_email'::text])))
);

CREATE SEQUENCE public.password_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.password_tokens_id_seq OWNED BY public.password_tokens.id;

CREATE TABLE public.run_events (
    id bigint NOT NULL,
    execution_id integer NOT NULL,
    seq integer NOT NULL,
    type text NOT NULL,
    status text,
    step_index integer,
    attempt integer,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.run_events_id_seq OWNED BY public.run_events.id;

CREATE TABLE public.schedules (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    case_id integer,
    suite_id integer,
    cron text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    CONSTRAINT schedules_check CHECK (((case_id IS NULL) <> (suite_id IS NULL)))
);

CREATE SEQUENCE public.schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.schedules_id_seq OWNED BY public.schedules.id;

CREATE TABLE public.secrets (
    id integer NOT NULL,
    workspace_id integer NOT NULL,
    name text NOT NULL,
    ciphertext text NOT NULL,
    description text,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT secrets_name_check CHECK ((name ~ '^[A-Z][A-Z0-9_]{0,63}$'::text))
);

CREATE SEQUENCE public.secrets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.secrets_id_seq OWNED BY public.secrets.id;

CREATE TABLE public.sessions (
    sid character varying NOT NULL,
    sess jsonb NOT NULL,
    expire timestamp without time zone NOT NULL
);

CREATE TABLE public.step_executions (
    id integer NOT NULL,
    execution_id integer NOT NULL,
    step_id integer,
    status text NOT NULL,
    duration integer,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    attempt integer DEFAULT 1 NOT NULL,
    step_index integer,
    step_name text,
    action text,
    log text,
    started_at timestamp with time zone
);

CREATE SEQUENCE public.step_executions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.step_executions_id_seq OWNED BY public.step_executions.id;

CREATE TABLE public.system_state (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.test_cases (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    suite_id integer NOT NULL,
    max_retries integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    workspace_id integer NOT NULL,
    environment_id integer,
    priority text DEFAULT 'normal'::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    timeout_ms integer DEFAULT 300000 NOT NULL,
    step_timeout_ms integer DEFAULT 15000 NOT NULL,
    overlap_policy text DEFAULT 'skip'::text NOT NULL,
    published_version integer,
    draft_updated_at timestamp with time zone,
    draft_updated_by character varying,
    needs_review boolean DEFAULT false NOT NULL,
    review_note text,
    created_by character varying,
    CONSTRAINT test_cases_overlap_policy_check CHECK ((overlap_policy = ANY (ARRAY['skip'::text, 'queue'::text, 'cancel_previous'::text]))),
    CONSTRAINT test_cases_priority_check CHECK ((priority = ANY (ARRAY['critical'::text, 'high'::text, 'normal'::text, 'low'::text])))
);

CREATE SEQUENCE public.test_cases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.test_cases_id_seq OWNED BY public.test_cases.id;

CREATE TABLE public.test_executions (
    id integer NOT NULL,
    case_id integer NOT NULL,
    status text NOT NULL,
    start_time timestamp with time zone,
    end_time timestamp with time zone,
    duration integer,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    workspace_id integer NOT NULL,
    case_version integer,
    environment_id integer,
    trigger text DEFAULT 'manual'::text NOT NULL,
    schedule_id integer,
    batch_id text,
    requested_by character varying,
    idempotency_key text,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    max_attempts integer DEFAULT 1 NOT NULL,
    worker_id text,
    lease_expires_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    cancel_requested_at timestamp with time zone,
    cancelled_by character varying,
    error_category text,
    failed_step_index integer,
    warnings integer DEFAULT 0 NOT NULL,
    CONSTRAINT test_executions_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'cancel_requested'::text, 'passed'::text, 'failed'::text, 'timed_out'::text, 'cancelled'::text, 'infrastructure_error'::text]))),
    CONSTRAINT test_executions_trigger_check CHECK ((trigger = ANY (ARRAY['manual'::text, 'schedule'::text, 'api'::text])))
);

CREATE SEQUENCE public.test_executions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.test_executions_id_seq OWNED BY public.test_executions.id;

CREATE TABLE public.test_steps (
    id integer NOT NULL,
    case_id integer NOT NULL,
    step_order integer NOT NULL,
    step_name text NOT NULL,
    action text NOT NULL,
    locator_type text,
    locator_value text,
    input_value text,
    created_at timestamp with time zone DEFAULT now(),
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL
);

CREATE SEQUENCE public.test_steps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.test_steps_id_seq OWNED BY public.test_steps.id;

CREATE TABLE public.test_suites (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    user_id character varying,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    workspace_id integer NOT NULL,
    environment_id integer,
    tags text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE SEQUENCE public.test_suites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.test_suites_id_seq OWNED BY public.test_suites.id;

CREATE TABLE public.users (
    id character varying NOT NULL,
    email character varying,
    first_name character varying,
    last_name character varying,
    profile_image_url character varying,
    password_hash character varying,
    auth_provider character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    is_system_admin boolean DEFAULT false NOT NULL,
    email_verified_at timestamp with time zone,
    disabled_at timestamp with time zone,
    last_login_at timestamp with time zone
);

CREATE TABLE public.worker_heartbeats (
    worker_id text NOT NULL,
    hostname text,
    version text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    current_execution_id integer,
    browser_ok boolean
);

CREATE TABLE public.workspaces (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    ai_enabled boolean DEFAULT false NOT NULL,
    ai_monthly_budget_cents integer DEFAULT 2000 NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.workspaces_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.workspaces_id_seq OWNED BY public.workspaces.id;

ALTER TABLE ONLY public.ai_requests ALTER COLUMN id SET DEFAULT nextval('public.ai_requests_id_seq'::regclass);

ALTER TABLE ONLY public.artifacts ALTER COLUMN id SET DEFAULT nextval('public.artifacts_id_seq'::regclass);

ALTER TABLE ONLY public.audit_events ALTER COLUMN id SET DEFAULT nextval('public.audit_events_id_seq'::regclass);

ALTER TABLE ONLY public.case_versions ALTER COLUMN id SET DEFAULT nextval('public.case_versions_id_seq'::regclass);

ALTER TABLE ONLY public.environments ALTER COLUMN id SET DEFAULT nextval('public.environments_id_seq'::regclass);

ALTER TABLE ONLY public.incidents ALTER COLUMN id SET DEFAULT nextval('public.incidents_id_seq'::regclass);

ALTER TABLE ONLY public.invitations ALTER COLUMN id SET DEFAULT nextval('public.invitations_id_seq'::regclass);

ALTER TABLE ONLY public.notification_deliveries ALTER COLUMN id SET DEFAULT nextval('public.notification_deliveries_id_seq'::regclass);

ALTER TABLE ONLY public.notification_rules ALTER COLUMN id SET DEFAULT nextval('public.notification_rules_id_seq'::regclass);

ALTER TABLE ONLY public.password_tokens ALTER COLUMN id SET DEFAULT nextval('public.password_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.run_events ALTER COLUMN id SET DEFAULT nextval('public.run_events_id_seq'::regclass);

ALTER TABLE ONLY public.schedules ALTER COLUMN id SET DEFAULT nextval('public.schedules_id_seq'::regclass);

ALTER TABLE ONLY public.secrets ALTER COLUMN id SET DEFAULT nextval('public.secrets_id_seq'::regclass);

ALTER TABLE ONLY public.step_executions ALTER COLUMN id SET DEFAULT nextval('public.step_executions_id_seq'::regclass);

ALTER TABLE ONLY public.test_cases ALTER COLUMN id SET DEFAULT nextval('public.test_cases_id_seq'::regclass);

ALTER TABLE ONLY public.test_executions ALTER COLUMN id SET DEFAULT nextval('public.test_executions_id_seq'::regclass);

ALTER TABLE ONLY public.test_steps ALTER COLUMN id SET DEFAULT nextval('public.test_steps_id_seq'::regclass);

ALTER TABLE ONLY public.test_suites ALTER COLUMN id SET DEFAULT nextval('public.test_suites_id_seq'::regclass);

ALTER TABLE ONLY public.workspaces ALTER COLUMN id SET DEFAULT nextval('public.workspaces_id_seq'::regclass);

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.case_versions
    ADD CONSTRAINT case_versions_case_id_version_key UNIQUE (case_id, version);

ALTER TABLE ONLY public.case_versions
    ADD CONSTRAINT case_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_workspace_id_name_key UNIQUE (workspace_id, name);

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (workspace_id, user_id);

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_rules
    ADD CONSTRAINT notification_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.password_tokens
    ADD CONSTRAINT password_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.password_tokens
    ADD CONSTRAINT password_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_execution_id_seq_key UNIQUE (execution_id, seq);

ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_workspace_id_name_key UNIQUE (workspace_id, name);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (sid);

ALTER TABLE ONLY public.step_executions
    ADD CONSTRAINT step_executions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.system_state
    ADD CONSTRAINT system_state_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.test_executions
    ADD CONSTRAINT test_executions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.test_steps
    ADD CONSTRAINT test_steps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.test_suites
    ADD CONSTRAINT test_suites_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.worker_heartbeats
    ADD CONSTRAINT worker_heartbeats_pkey PRIMARY KEY (worker_id);

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_slug_key UNIQUE (slug);

CREATE INDEX "IDX_session_expire" ON public.sessions USING btree (expire);

CREATE INDEX ai_requests_workspace_idx ON public.ai_requests USING btree (workspace_id, created_at DESC);

CREATE INDEX artifacts_execution_idx ON public.artifacts USING btree (execution_id);

CREATE INDEX audit_events_workspace_idx ON public.audit_events USING btree (workspace_id, created_at DESC);

CREATE UNIQUE INDEX incidents_open_idx ON public.incidents USING btree (case_id) WHERE (resolved_at IS NULL);

CREATE INDEX invitations_workspace_idx ON public.invitations USING btree (workspace_id);

CREATE INDEX memberships_user_idx ON public.memberships USING btree (user_id);

CREATE INDEX notification_deliveries_workspace_idx ON public.notification_deliveries USING btree (workspace_id, created_at DESC);

CREATE INDEX notification_rules_workspace_idx ON public.notification_rules USING btree (workspace_id);

CREATE INDEX schedules_due_idx ON public.schedules USING btree (next_run_at) WHERE (NOT paused);

CREATE INDEX step_executions_execution_idx ON public.step_executions USING btree (execution_id, attempt, step_index);

CREATE INDEX test_cases_workspace_idx ON public.test_cases USING btree (workspace_id, suite_id);

CREATE INDEX test_executions_active_idx ON public.test_executions USING btree (status) WHERE (status = ANY (ARRAY['starting'::text, 'running'::text, 'cancel_requested'::text]));

CREATE INDEX test_executions_case_idx ON public.test_executions USING btree (case_id, created_at DESC);

CREATE UNIQUE INDEX test_executions_idempotency_idx ON public.test_executions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE INDEX test_executions_queue_idx ON public.test_executions USING btree (queued_at) WHERE (status = 'queued'::text);

CREATE INDEX test_executions_workspace_idx ON public.test_executions USING btree (workspace_id, created_at DESC);

CREATE INDEX test_steps_case_idx ON public.test_steps USING btree (case_id, step_order);

CREATE INDEX test_suites_workspace_idx ON public.test_suites USING btree (workspace_id);

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.test_cases(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.test_executions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.ai_requests
    ADD CONSTRAINT ai_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.test_executions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.case_versions
    ADD CONSTRAINT case_versions_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.case_versions
    ADD CONSTRAINT case_versions_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.case_versions
    ADD CONSTRAINT case_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_opened_by_execution_id_fkey FOREIGN KEY (opened_by_execution_id) REFERENCES public.test_executions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_resolved_by_execution_id_fkey FOREIGN KEY (resolved_by_execution_id) REFERENCES public.test_executions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.incidents
    ADD CONSTRAINT incidents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.test_executions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.incidents(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.notification_rules(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_rules
    ADD CONSTRAINT notification_rules_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_rules
    ADD CONSTRAINT notification_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.notification_rules
    ADD CONSTRAINT notification_rules_suite_id_fkey FOREIGN KEY (suite_id) REFERENCES public.test_suites(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_rules
    ADD CONSTRAINT notification_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.password_tokens
    ADD CONSTRAINT password_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.test_executions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_suite_id_fkey FOREIGN KEY (suite_id) REFERENCES public.test_suites(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.step_executions
    ADD CONSTRAINT step_executions_execution_id_test_executions_id_fk FOREIGN KEY (execution_id) REFERENCES public.test_executions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.step_executions
    ADD CONSTRAINT step_executions_step_id_test_steps_id_fk FOREIGN KEY (step_id) REFERENCES public.test_steps(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.system_state
    ADD CONSTRAINT system_state_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_draft_updated_by_fkey FOREIGN KEY (draft_updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_suite_id_test_suites_id_fk FOREIGN KEY (suite_id) REFERENCES public.test_suites(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.test_executions
    ADD CONSTRAINT test_executions_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_executions
    ADD CONSTRAINT test_executions_case_id_test_cases_id_fk FOREIGN KEY (case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.test_executions
    ADD CONSTRAINT test_executions_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_executions
    ADD CONSTRAINT test_executions_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_executions
    ADD CONSTRAINT test_executions_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.schedules(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_executions
    ADD CONSTRAINT test_executions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.test_steps
    ADD CONSTRAINT test_steps_case_id_test_cases_id_fk FOREIGN KEY (case_id) REFERENCES public.test_cases(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.test_suites
    ADD CONSTRAINT test_suites_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_suites
    ADD CONSTRAINT test_suites_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.test_suites
    ADD CONSTRAINT test_suites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- Emergency stop switch (System page). Off on a new install.
INSERT INTO public.system_state (key, value) VALUES ('dispatch_paused', 'false');
