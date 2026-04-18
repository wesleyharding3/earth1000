--
-- PostgreSQL database dump
--

\restrict 0FPOy1UASB7DQqDqQkZ3rfrewWknjWx6053inYAOZctEFQpRZzpFuxPg3c4Bt4g

-- Dumped from database version 18.3 (Debian 18.3-1.pgdg12+1)
-- Dumped by pg_dump version 18.3 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: political_bias_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.political_bias_enum AS ENUM (
    'left',
    'center_left',
    'center',
    'center_right',
    'right',
    'state',
    'unknown'
);


--
-- Name: source_fetch_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.source_fetch_type AS ENUM (
    'rss',
    'atom',
    'xml_feed',
    'news_sitemap',
    'xml_sitemap',
    'html_list',
    'html_roll',
    'html_table',
    'mobile_html',
    'amp_list',
    'json_api',
    'site_search',
    'archive_index',
    'headless_html',
    'aggregator',
    'wechat_feed',
    'telegram_channel'
);


--
-- Name: delete_panels_for_episode(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_panels_for_episode(p_episode_id integer) RETURNS void
    LANGUAGE sql
    AS $$
  DELETE FROM data_panels
  WHERE scope_type = 'briefing_segment' AND scope_id = p_episode_id;
$$;


--
-- Name: notify_new_article(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_article() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('new_article', NEW.id::text);
  RETURN NEW;
END;
$$;


--
-- Name: sync_popularity_score(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_popularity_score() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.popularity_score :=
    CASE NEW.popularity_tier
      WHEN 1 THEN 0.85
      WHEN 2 THEN 1.00
      WHEN 3 THEN 1.35
      ELSE 1.00
    END;
  RETURN NEW;
END;
$$;


SET default_table_access_method = heap;

--
-- Name: article_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_entities (
    id integer NOT NULL,
    article_id integer NOT NULL,
    entity_text text NOT NULL,
    entity_type text NOT NULL,
    relevance double precision DEFAULT 0.5 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT article_entities_entity_type_check CHECK ((entity_type = ANY (ARRAY['person'::text, 'organization'::text, 'location'::text, 'event'::text])))
);


--
-- Name: article_entities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.article_entities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: article_entities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.article_entities_id_seq OWNED BY public.article_entities.id;


--
-- Name: article_entity_extraction_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_entity_extraction_state (
    article_id integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    entities_found integer DEFAULT 0 NOT NULL,
    dates_found integer DEFAULT 0 NOT NULL,
    error_message text,
    processed_at timestamp with time zone,
    CONSTRAINT article_entity_extraction_state_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: article_entity_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_entity_mentions (
    id bigint NOT NULL,
    article_id integer NOT NULL,
    entity_id integer NOT NULL,
    role text NOT NULL,
    confidence numeric(4,3) DEFAULT 0.75 NOT NULL,
    extracted_by text DEFAULT 'claude'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT article_entity_mentions_role_check CHECK ((role = ANY (ARRAY['subject'::text, 'actor'::text, 'location'::text, 'referenced'::text, 'referenced_historical'::text, 'source'::text])))
);


--
-- Name: article_entity_mentions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.article_entity_mentions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: article_entity_mentions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.article_entity_mentions_id_seq OWNED BY public.article_entity_mentions.id;


--
-- Name: article_image_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_image_assignments (
    article_id integer NOT NULL,
    image_id integer,
    source_type character varying(32) DEFAULT 'fallback'::character varying NOT NULL,
    match_strategy text,
    matched_tag_id integer,
    matched_keyword text,
    matched_category text,
    confidence double precision DEFAULT 0 NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    refreshed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: article_keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_keywords (
    id integer NOT NULL,
    article_id integer NOT NULL,
    keyword text NOT NULL,
    source_language text NOT NULL,
    frequency smallint DEFAULT 1 NOT NULL,
    extracted_at timestamp with time zone DEFAULT now(),
    normalized_keyword text
);


--
-- Name: article_keywords_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.article_keywords_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: article_keywords_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.article_keywords_id_seq OWNED BY public.article_keywords.id;


--
-- Name: article_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_locations (
    article_id integer NOT NULL,
    country_id integer NOT NULL,
    city_id integer,
    routing_type character varying(50)
);


--
-- Name: article_referenced_dates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_referenced_dates (
    id bigint NOT NULL,
    article_id integer NOT NULL,
    referenced_date date NOT NULL,
    date_precision text DEFAULT 'day'::text NOT NULL,
    context_snippet text,
    confidence numeric(4,3) DEFAULT 0.75 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT article_referenced_dates_date_precision_check CHECK ((date_precision = ANY (ARRAY['day'::text, 'month'::text, 'year'::text, 'decade'::text, 'century'::text])))
);


--
-- Name: article_referenced_dates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.article_referenced_dates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: article_referenced_dates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.article_referenced_dates_id_seq OWNED BY public.article_referenced_dates.id;


--
-- Name: article_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_tags (
    article_id integer NOT NULL,
    tag_id integer NOT NULL,
    rank integer,
    score double precision
);


--
-- Name: backfill_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backfill_progress (
    job_name text NOT NULL,
    last_id bigint DEFAULT 0 NOT NULL,
    done integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: briefing_access_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.briefing_access_log (
    user_id uuid NOT NULL,
    episode_id integer NOT NULL,
    accessed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: briefing_curation_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.briefing_curation_history (
    id integer NOT NULL,
    chosen_at timestamp with time zone DEFAULT now() NOT NULL,
    episode_id integer,
    thread_ids integer[] NOT NULL,
    categories text[] DEFAULT '{}'::text[] NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    regions text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: briefing_curation_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.briefing_curation_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: briefing_curation_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.briefing_curation_history_id_seq OWNED BY public.briefing_curation_history.id;


--
-- Name: briefing_engagement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.briefing_engagement (
    id integer NOT NULL,
    user_id uuid,
    episode_id integer,
    thread_id integer,
    action text NOT NULL,
    dwell_seconds integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: briefing_engagement_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.briefing_engagement_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: briefing_engagement_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.briefing_engagement_id_seq OWNED BY public.briefing_engagement.id;


--
-- Name: briefing_episodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.briefing_episodes (
    id integer NOT NULL,
    user_id uuid,
    target_date date NOT NULL,
    headline text,
    voiceover_script text,
    audio_url text,
    segments jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    audio_data bytea,
    location_type character varying(10),
    location_id integer,
    location_name text,
    music_data bytea,
    music_meta jsonb
);


--
-- Name: briefing_episodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.briefing_episodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: briefing_episodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.briefing_episodes_id_seq OWNED BY public.briefing_episodes.id;


--
-- Name: briefing_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.briefing_preferences (
    user_id uuid NOT NULL,
    topic_weights jsonb DEFAULT '{}'::jsonb NOT NULL,
    geo_focus text[] DEFAULT '{}'::text[] NOT NULL,
    briefing_time time without time zone DEFAULT '08:00:00'::time without time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cities (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    country_id integer NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    population bigint,
    timezone text,
    is_active boolean DEFAULT true,
    priority_score double precision DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    blurb text,
    fame_index double precision DEFAULT 0,
    gdp bigint,
    region_id integer,
    is_capital boolean DEFAULT false
);


--
-- Name: cities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cities_id_seq OWNED BY public.cities.id;


--
-- Name: city_location_keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.city_location_keywords (
    id integer NOT NULL,
    city_id integer NOT NULL,
    phrase character varying(255) NOT NULL,
    is_phrase boolean DEFAULT true,
    tier_id integer,
    threshold double precision DEFAULT 1.0,
    country_id integer
);


--
-- Name: city_location_keywords_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.city_location_keywords_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: city_location_keywords_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.city_location_keywords_id_seq OWNED BY public.city_location_keywords.id;


--
-- Name: cluster_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cluster_edges (
    id integer NOT NULL,
    run_id integer NOT NULL,
    source_thread_id integer NOT NULL,
    target_thread_id integer NOT NULL,
    weight double precision NOT NULL,
    reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cluster_edges_check CHECK ((source_thread_id <> target_thread_id)),
    CONSTRAINT cluster_edges_weight_check CHECK (((weight >= (0)::double precision) AND (weight <= (1)::double precision)))
);


--
-- Name: cluster_edges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cluster_edges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cluster_edges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cluster_edges_id_seq OWNED BY public.cluster_edges.id;


--
-- Name: cluster_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cluster_groups (
    id integer NOT NULL,
    run_id integer NOT NULL,
    cluster_id text NOT NULL,
    label text NOT NULL,
    summary text,
    primary_category text,
    node_count integer DEFAULT 0 NOT NULL,
    article_count integer DEFAULT 0 NOT NULL,
    language_count integer DEFAULT 0 NOT NULL,
    source_country_count integer DEFAULT 0 NOT NULL,
    centroid_x double precision NOT NULL,
    centroid_y double precision NOT NULL,
    centroid_z double precision NOT NULL,
    spread double precision DEFAULT 0 NOT NULL,
    shared_properties jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cluster_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cluster_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cluster_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cluster_groups_id_seq OWNED BY public.cluster_groups.id;


--
-- Name: cluster_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cluster_nodes (
    id integer NOT NULL,
    run_id integer NOT NULL,
    thread_id integer NOT NULL,
    story_identity_id integer,
    cluster_id text NOT NULL,
    title text NOT NULL,
    description text,
    primary_category text,
    importance integer,
    article_count integer DEFAULT 0 NOT NULL,
    language_count integer DEFAULT 0 NOT NULL,
    source_country_count integer DEFAULT 0 NOT NULL,
    feature_keywords jsonb DEFAULT '[]'::jsonb NOT NULL,
    top_countries jsonb DEFAULT '[]'::jsonb NOT NULL,
    top_languages jsonb DEFAULT '[]'::jsonb NOT NULL,
    x double precision NOT NULL,
    y double precision NOT NULL,
    z double precision NOT NULL,
    radius double precision DEFAULT 1 NOT NULL,
    density_score double precision DEFAULT 0 NOT NULL,
    novelty_score double precision DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cluster_nodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cluster_nodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cluster_nodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cluster_nodes_id_seq OWNED BY public.cluster_nodes.id;


--
-- Name: cluster_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cluster_runs (
    id integer NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    preset text DEFAULT '7d'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    algorithm_version text NOT NULL,
    thread_count integer DEFAULT 0 NOT NULL,
    group_count integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    error_message text,
    CONSTRAINT cluster_runs_check CHECK ((window_end > window_start)),
    CONSTRAINT cluster_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: cluster_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cluster_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cluster_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cluster_runs_id_seq OWNED BY public.cluster_runs.id;


--
-- Name: continents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.continents (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL
);


--
-- Name: continents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.continents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: continents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.continents_id_seq OWNED BY public.continents.id;


--
-- Name: countries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.countries (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    iso_code character(2),
    region text,
    population bigint,
    created_at timestamp without time zone DEFAULT now(),
    continent_id integer,
    region_id integer,
    flag text,
    blurb text,
    is_active boolean,
    gdp bigint
);


--
-- Name: countries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.countries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: countries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.countries_id_seq OWNED BY public.countries.id;


--
-- Name: country_feed_boost; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.country_feed_boost (
    country_id integer NOT NULL,
    boost_score numeric DEFAULT 1.0 NOT NULL
);


--
-- Name: country_location_keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.country_location_keywords (
    id integer NOT NULL,
    country_id integer NOT NULL,
    phrase character varying(255) NOT NULL,
    is_phrase boolean DEFAULT true,
    tier_id integer,
    threshold double precision DEFAULT 1.0,
    region_type character varying(50) DEFAULT 'country'::character varying
);


--
-- Name: country_location_keywords_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.country_location_keywords_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: country_location_keywords_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.country_location_keywords_id_seq OWNED BY public.country_location_keywords.id;


--
-- Name: country_regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.country_regions (
    country_id integer NOT NULL,
    region_id integer NOT NULL
);


--
-- Name: custom_briefing_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_briefing_usage (
    user_id uuid NOT NULL,
    usage_month text NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: data_panels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_panels (
    id integer NOT NULL,
    scope_type text NOT NULL,
    scope_id integer NOT NULL,
    segment_index integer,
    ord integer DEFAULT 0 NOT NULL,
    title text NOT NULL,
    subtitle text,
    caption text,
    chart_type text NOT NULL,
    data jsonb NOT NULL,
    source_name text,
    source_url text,
    generated_by text DEFAULT 'ai_real'::text NOT NULL,
    adapter text,
    query jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_panels_chart_type_check CHECK ((chart_type = ANY (ARRAY['line'::text, 'bar'::text, 'stacked_bar'::text, 'area'::text, 'pie'::text, 'scatter'::text]))),
    CONSTRAINT data_panels_generated_by_check CHECK ((generated_by = ANY (ARRAY['ai_real'::text, 'ai_composed'::text, 'manual'::text]))),
    CONSTRAINT data_panels_scope_type_check CHECK ((scope_type = ANY (ARRAY['briefing_segment'::text, 'thread'::text, 'timeline'::text])))
);


--
-- Name: data_panels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.data_panels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: data_panels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.data_panels_id_seq OWNED BY public.data_panels.id;


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id integer NOT NULL,
    canonical_name text NOT NULL,
    entity_type text NOT NULL,
    wikidata_qid text,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    description text,
    country_code text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entities_entity_type_check CHECK ((entity_type = ANY (ARRAY['person'::text, 'organization'::text, 'location'::text, 'ideology'::text, 'event'::text, 'work'::text, 'other'::text])))
);


--
-- Name: entities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entities_id_seq OWNED BY public.entities.id;


--
-- Name: entity_event_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_event_metadata (
    entity_id integer NOT NULL,
    start_date date,
    end_date date,
    date_precision text DEFAULT 'day'::text NOT NULL,
    location_text text,
    latitude numeric(9,6),
    longitude numeric(9,6),
    summary text,
    CONSTRAINT entity_event_metadata_date_precision_check CHECK ((date_precision = ANY (ARRAY['day'::text, 'month'::text, 'year'::text, 'decade'::text, 'century'::text])))
);


--
-- Name: entity_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_relationships (
    id integer NOT NULL,
    from_entity_id integer NOT NULL,
    to_entity_id integer NOT NULL,
    relationship_type text NOT NULL,
    start_date date,
    end_date date,
    date_precision text DEFAULT 'year'::text NOT NULL,
    confidence numeric(4,3) DEFAULT 0.5 NOT NULL,
    source_refs jsonb NOT NULL,
    notes text,
    extracted_by text DEFAULT 'claude'::text NOT NULL,
    review_status text DEFAULT 'unreviewed'::text NOT NULL,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_relationships_check CHECK ((from_entity_id <> to_entity_id)),
    CONSTRAINT entity_relationships_date_precision_check CHECK ((date_precision = ANY (ARRAY['day'::text, 'month'::text, 'year'::text, 'decade'::text, 'century'::text]))),
    CONSTRAINT entity_relationships_relationship_type_check CHECK ((relationship_type = ANY (ARRAY['caused'::text, 'enabled'::text, 'prevented'::text, 'retaliated_against'::text, 'founded'::text, 'member_of'::text, 'succeeded'::text, 'split_from'::text, 'allied_with'::text, 'opposed'::text, 'funded'::text, 'armed'::text, 'trained'::text, 'supplied'::text, 'occurred_at'::text, 'occurred_during'::text, 'referenced_by'::text, 'framed_as'::text]))),
    CONSTRAINT entity_relationships_review_status_check CHECK ((review_status = ANY (ARRAY['unreviewed'::text, 'approved'::text, 'rejected'::text, 'needs_evidence'::text]))),
    CONSTRAINT entity_relationships_source_refs_check CHECK (((jsonb_typeof(source_refs) = 'array'::text) AND (jsonb_array_length(source_refs) > 0)))
);


--
-- Name: entity_relationships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_relationships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_relationships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_relationships_id_seq OWNED BY public.entity_relationships.id;


--
-- Name: environmental_entity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environmental_entity (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    entity_type text NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    area_km2 double precision,
    biome text,
    timezone text,
    is_active boolean DEFAULT true,
    priority_score double precision DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: environmental_entity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.environmental_entity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: environmental_entity_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.environmental_entity_id_seq OWNED BY public.environmental_entity.id;


--
-- Name: exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exports (
    id integer NOT NULL,
    country_id integer NOT NULL,
    city_id integer,
    name text NOT NULL,
    rank integer NOT NULL,
    annual_profit numeric(18,2),
    CONSTRAINT exports_rank_check CHECK (((rank >= 1) AND (rank <= 5)))
);


--
-- Name: exports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.exports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: exports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.exports_id_seq OWNED BY public.exports.id;


--
-- Name: heatmap_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.heatmap_snapshots (
    id integer NOT NULL,
    preset text NOT NULL,
    level text NOT NULL,
    ref_id integer NOT NULL,
    country_id integer,
    iso text,
    country_name text,
    name text NOT NULL,
    lat double precision NOT NULL,
    lon double precision NOT NULL,
    n integer DEFAULT 0 NOT NULL,
    sent_n integer DEFAULT 0 NOT NULL,
    avg_sent double precision,
    refreshed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT heatmap_snapshots_level_check CHECK ((level = ANY (ARRAY['country'::text, 'city'::text])))
);


--
-- Name: heatmap_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.heatmap_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: heatmap_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.heatmap_snapshots_id_seq OWNED BY public.heatmap_snapshots.id;


--
-- Name: heatmap_ts_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.heatmap_ts_snapshots (
    id integer NOT NULL,
    preset text NOT NULL,
    level text NOT NULL,
    bucket_time timestamp with time zone NOT NULL,
    ref_id integer NOT NULL,
    country_id integer,
    iso text,
    country_name text,
    name text NOT NULL,
    lat double precision NOT NULL,
    lon double precision NOT NULL,
    n integer DEFAULT 0 NOT NULL,
    sent_n integer DEFAULT 0 NOT NULL,
    avg_sent double precision,
    refreshed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT heatmap_ts_snapshots_level_check CHECK ((level = ANY (ARRAY['country'::text, 'city'::text])))
);


--
-- Name: heatmap_ts_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.heatmap_ts_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: heatmap_ts_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.heatmap_ts_snapshots_id_seq OWNED BY public.heatmap_ts_snapshots.id;


--
-- Name: image_asset_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_asset_tags (
    image_id integer NOT NULL,
    tag_id integer NOT NULL,
    weight double precision DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: image_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_assets (
    id integer NOT NULL,
    public_url text NOT NULL,
    object_path text NOT NULL,
    folder_path text,
    file_name text,
    primary_category text,
    generic_category text,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    city_id integer,
    country_id integer,
    priority double precision DEFAULT 1 NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: image_assets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_assets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_assets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_assets_id_seq OWNED BY public.image_assets.id;


--
-- Name: image_category_fallbacks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_category_fallbacks (
    category text NOT NULL,
    fallback_category text NOT NULL,
    priority integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: image_usage_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_usage_log (
    id bigint NOT NULL,
    article_id integer,
    image_id integer,
    surface character varying(32) DEFAULT 'feed'::character varying NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: image_usage_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_usage_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_usage_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_usage_log_id_seq OWNED BY public.image_usage_log.id;


--
-- Name: imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imports (
    id integer NOT NULL,
    country_id integer NOT NULL,
    city_id integer,
    name text NOT NULL,
    rank integer,
    annual_cost numeric,
    CONSTRAINT imports_rank_check CHECK (((rank >= 1) AND (rank <= 5)))
);


--
-- Name: imports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.imports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: imports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.imports_id_seq OWNED BY public.imports.id;


--
-- Name: ingestion_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingestion_runs (
    id integer NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    status text,
    articles_added integer DEFAULT 0,
    articles_updated integer DEFAULT 0,
    errors integer DEFAULT 0
);


--
-- Name: ingestion_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ingestion_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ingestion_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ingestion_runs_id_seq OWNED BY public.ingestion_runs.id;


--
-- Name: keyword_backfill_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keyword_backfill_progress (
    id integer NOT NULL,
    last_article_id integer DEFAULT 0 NOT NULL,
    total_processed integer DEFAULT 0 NOT NULL,
    total_articles integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone
);


--
-- Name: keyword_backfill_progress_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.keyword_backfill_progress_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: keyword_backfill_progress_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.keyword_backfill_progress_id_seq OWNED BY public.keyword_backfill_progress.id;


--
-- Name: keyword_daily_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keyword_daily_stats (
    id integer NOT NULL,
    keyword text NOT NULL,
    date date NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    language_group_count smallint DEFAULT 1 NOT NULL,
    source_country_id integer,
    about_country_id integer
);


--
-- Name: keyword_daily_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.keyword_daily_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: keyword_daily_stats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.keyword_daily_stats_id_seq OWNED BY public.keyword_daily_stats.id;


--
-- Name: keyword_intelligence_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keyword_intelligence_cache (
    id integer NOT NULL,
    mode text NOT NULL,
    filter_key text DEFAULT 'global'::text NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    results jsonb NOT NULL,
    CONSTRAINT keyword_intelligence_cache_mode_check CHECK ((mode = ANY (ARRAY['trending'::text, 'rising'::text, 'sources-stats'::text, 'globe-stats'::text])))
);


--
-- Name: keyword_intelligence_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.keyword_intelligence_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: keyword_intelligence_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.keyword_intelligence_cache_id_seq OWNED BY public.keyword_intelligence_cache.id;


--
-- Name: keyword_normalizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keyword_normalizations (
    keyword text NOT NULL,
    normalized text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: keyword_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keyword_tiers (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    base_score integer NOT NULL,
    description text,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT keyword_tiers_base_score_check CHECK ((base_score > 0))
);


--
-- Name: keyword_tiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.keyword_tiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: keyword_tiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.keyword_tiers_id_seq OWNED BY public.keyword_tiers.id;


--
-- Name: keyword_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keyword_translations (
    id integer NOT NULL,
    original_keyword text NOT NULL,
    source_language text DEFAULT 'auto'::text,
    normalized_keyword text NOT NULL,
    confidence real DEFAULT 1.0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: keyword_translations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.keyword_translations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: keyword_translations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.keyword_translations_id_seq OWNED BY public.keyword_translations.id;


--
-- Name: keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keywords (
    id integer NOT NULL,
    phrase character varying(255) NOT NULL,
    is_phrase boolean DEFAULT false
);


--
-- Name: keywords_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.keywords_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: keywords_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.keywords_id_seq OWNED BY public.keywords.id;


--
-- Name: languages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.languages (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    iso_code_2 character(2) NOT NULL,
    iso_code_3 character(3),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: languages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.languages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: languages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.languages_id_seq OWNED BY public.languages.id;


--
-- Name: news_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.news_articles (
    id integer NOT NULL,
    source_id integer,
    city_id integer,
    country_id integer,
    title text NOT NULL,
    url text NOT NULL,
    summary text,
    content text,
    published_at timestamp without time zone,
    ingested_at timestamp without time zone DEFAULT now(),
    sentiment_score double precision,
    language text,
    translated_title text,
    translated_summary text,
    image_url text,
    article_url text,
    base_priority double precision DEFAULT 0,
    media_type character varying(20) DEFAULT 'article'::character varying,
    video_id text,
    duration_seconds integer,
    youtube_source_id integer,
    deep_analyzed_at timestamp with time zone
);


--
-- Name: news_articles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.news_articles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: news_articles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.news_articles_id_seq OWNED BY public.news_articles.id;


--
-- Name: news_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.news_sources (
    id integer NOT NULL,
    name text NOT NULL,
    site_url text,
    rss_url text NOT NULL,
    city_id integer,
    country_id integer,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    slug text,
    failure_count integer DEFAULT 0,
    last_failed_at timestamp without time zone,
    last_success_at timestamp without time zone,
    last_error text,
    language_id integer,
    city_name character varying(255),
    language character varying(10),
    last_checked_at timestamp with time zone,
    popularity_tier integer DEFAULT 1 NOT NULL,
    popularity_score numeric(4,2) DEFAULT 1.00 NOT NULL,
    source_type public.source_fetch_type DEFAULT 'rss'::public.source_fetch_type NOT NULL,
    scrape_url text,
    scrape_config jsonb,
    bias public.political_bias_enum,
    fetch_tier integer DEFAULT 1 NOT NULL,
    fetch_tier_updated_at timestamp with time zone,
    fetch_tier_last_changed_at timestamp with time zone,
    fetch_bootstrap_phase text DEFAULT 'baseline'::text NOT NULL,
    fetch_bootstrap_baseline_runs integer DEFAULT 0 NOT NULL,
    fetch_bootstrap_baseline_empty_runs integer DEFAULT 0 NOT NULL,
    fetch_bootstrap_tier3_runs integer DEFAULT 0 NOT NULL,
    fetch_bootstrap_tier3_empty_runs integer DEFAULT 0 NOT NULL,
    fetch_bootstrap_tier4_runs integer DEFAULT 0 NOT NULL,
    fetch_bootstrap_tier4_empty_runs integer DEFAULT 0 NOT NULL,
    popularity_audited_at timestamp with time zone,
    source_summary text,
    CONSTRAINT news_sources_fetch_bootstrap_phase_check CHECK ((fetch_bootstrap_phase = ANY (ARRAY['baseline'::text, 'tier3_eval'::text, 'tier4_eval'::text, 'stable'::text]))),
    CONSTRAINT news_sources_fetch_tier_check CHECK (((fetch_tier >= 1) AND (fetch_tier <= 4)))
);


--
-- Name: news_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.news_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: news_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.news_sources_id_seq OWNED BY public.news_sources.id;


--
-- Name: ranking_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ranking_feedback (
    id integer NOT NULL,
    entity_type text NOT NULL,
    entity_id integer NOT NULL,
    old_rank integer,
    new_rank integer,
    old_importance real,
    new_importance real,
    article_count integer,
    source_count integer,
    breaking_signal real,
    category text,
    status text,
    age_hours real,
    feedback_by text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ranking_feedback_entity_type_check CHECK ((entity_type = ANY (ARRAY['thread'::text, 'timeline'::text])))
);


--
-- Name: ranking_feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ranking_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ranking_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ranking_feedback_id_seq OWNED BY public.ranking_feedback.id;


--
-- Name: ranking_model_weights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ranking_model_weights (
    id integer NOT NULL,
    entity_type text NOT NULL,
    feature_name text NOT NULL,
    weight real DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    sample_count integer DEFAULT 0,
    CONSTRAINT ranking_model_weights_entity_type_check CHECK ((entity_type = ANY (ARRAY['thread'::text, 'timeline'::text])))
);


--
-- Name: ranking_model_weights_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ranking_model_weights_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ranking_model_weights_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ranking_model_weights_id_seq OWNED BY public.ranking_model_weights.id;


--
-- Name: ranking_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ranking_overrides (
    id integer NOT NULL,
    entity_type text NOT NULL,
    entity_id integer NOT NULL,
    pinned_rank integer,
    boost real DEFAULT 0,
    pinned_by text,
    pinned_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ranking_overrides_entity_type_check CHECK ((entity_type = ANY (ARRAY['thread'::text, 'timeline'::text])))
);


--
-- Name: ranking_overrides_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ranking_overrides_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ranking_overrides_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ranking_overrides_id_seq OWNED BY public.ranking_overrides.id;


--
-- Name: regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regions (
    id integer NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    continent_id integer,
    color character varying(7),
    centroid_lng numeric(8,4),
    centroid_lat numeric(8,4),
    population bigint
);


--
-- Name: regions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.regions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: regions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.regions_id_seq OWNED BY public.regions.id;


--
-- Name: reroute_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reroute_progress (
    id integer NOT NULL,
    last_article_id bigint DEFAULT 0 NOT NULL,
    total_processed integer DEFAULT 0 NOT NULL,
    total_articles integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: reroute_progress_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reroute_progress_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reroute_progress_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reroute_progress_id_seq OWNED BY public.reroute_progress.id;


--
-- Name: rss_error_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rss_error_logs (
    id integer NOT NULL,
    feed_id integer,
    rss_url text,
    error_type text,
    error_message text,
    stack_trace text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: rss_error_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rss_error_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rss_error_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rss_error_logs_id_seq OWNED BY public.rss_error_logs.id;


--
-- Name: segment_story_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segment_story_links (
    id integer NOT NULL,
    briefing_episode_id integer NOT NULL,
    segment_index integer NOT NULL,
    thread_id integer,
    story_identity_id integer NOT NULL,
    day_number integer DEFAULT 1 NOT NULL,
    similarity_score numeric(5,4) DEFAULT 0,
    linked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: segment_story_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.segment_story_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: segment_story_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.segment_story_links_id_seq OWNED BY public.segment_story_links.id;


--
-- Name: source_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_health (
    source_id integer NOT NULL,
    last_successful_fetch timestamp with time zone,
    failure_count integer DEFAULT 0,
    is_active boolean DEFAULT true
);


--
-- Name: source_tag_weights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_tag_weights (
    source_id integer NOT NULL,
    tag_id integer NOT NULL,
    weight double precision NOT NULL
);


--
-- Name: stopwords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stopwords (
    id integer NOT NULL,
    word text NOT NULL,
    language text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: stopwords_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stopwords_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stopwords_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stopwords_id_seq OWNED BY public.stopwords.id;


--
-- Name: story_framing_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_framing_snapshots (
    id integer NOT NULL,
    story_identity_id integer NOT NULL,
    captured_at date NOT NULL,
    region text NOT NULL,
    headline_sample text,
    source_count integer DEFAULT 0 NOT NULL
);


--
-- Name: story_framing_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.story_framing_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: story_framing_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.story_framing_snapshots_id_seq OWNED BY public.story_framing_snapshots.id;


--
-- Name: story_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_identities (
    id integer NOT NULL,
    canonical_title text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    mention_count integer DEFAULT 1 NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: story_identities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.story_identities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: story_identities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.story_identities_id_seq OWNED BY public.story_identities.id;


--
-- Name: story_thread_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_thread_articles (
    thread_id integer NOT NULL,
    article_id integer NOT NULL,
    relevance_score double precision DEFAULT 1.0 NOT NULL,
    is_anchor boolean DEFAULT false NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: story_thread_builder_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_thread_builder_state (
    key text NOT NULL,
    value text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: story_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_threads (
    id integer NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'active'::text NOT NULL,
    importance double precision DEFAULT 1.0 NOT NULL,
    primary_category text,
    geographic_scope text DEFAULT 'global'::text NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    article_count integer DEFAULT 0 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    breaking_signal_score real,
    distinct_source_count integer DEFAULT 0,
    last_breaking_ping_at timestamp with time zone,
    primary_nations text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: story_threads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.story_threads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: story_threads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.story_threads_id_seq OWNED BY public.story_threads.id;


--
-- Name: story_timeline_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_timeline_articles (
    timeline_id integer NOT NULL,
    article_id integer NOT NULL,
    parabolic_weight real DEFAULT 0 NOT NULL,
    relevance_score real DEFAULT 0 NOT NULL,
    is_anchor boolean DEFAULT false NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: story_timelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_timelines (
    id integer NOT NULL,
    title text NOT NULL,
    description text,
    scope text,
    status text DEFAULT 'active'::text NOT NULL,
    importance double precision DEFAULT 5,
    primary_category text,
    geographic_scope text DEFAULT 'global'::text,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    article_count integer DEFAULT 0 NOT NULL,
    distinct_source_count integer DEFAULT 0 NOT NULL,
    lookback_days integer DEFAULT 7 NOT NULL,
    parabolic_peak_hours integer DEFAULT 24 NOT NULL,
    parabolic_weight_sum real DEFAULT 0 NOT NULL,
    historical_anchors jsonb DEFAULT '[]'::jsonb NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    primary_nations text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: story_timelines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.story_timelines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: story_timelines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.story_timelines_id_seq OWNED BY public.story_timelines.id;


--
-- Name: tag_keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tag_keywords (
    tag_id integer NOT NULL,
    keyword_id integer NOT NULL,
    tier_id integer
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id integer NOT NULL,
    name text NOT NULL
);


--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;


--
-- Name: user_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_usage (
    user_id uuid NOT NULL,
    usage_date date DEFAULT CURRENT_DATE NOT NULL,
    translations integer DEFAULT 0 NOT NULL,
    explanations integer DEFAULT 0 NOT NULL,
    kw_explanations integer DEFAULT 0 NOT NULL
);


--
-- Name: youtube_source_tag_weights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.youtube_source_tag_weights (
    youtube_source_id integer NOT NULL,
    tag_id integer NOT NULL,
    weight double precision NOT NULL
);


--
-- Name: youtube_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.youtube_sources (
    id integer NOT NULL,
    name text NOT NULL,
    channel_id text NOT NULL,
    channel_handle text,
    site_url text,
    rss_url text NOT NULL,
    city_id integer,
    country_id integer,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    slug text,
    failure_count integer DEFAULT 0,
    last_failed_at timestamp without time zone,
    last_success_at timestamp without time zone,
    last_error text,
    language_id integer,
    language character varying(10),
    last_checked_at timestamp with time zone,
    popularity_tier integer DEFAULT 1 NOT NULL,
    popularity_score numeric(4,2) DEFAULT 1.00 NOT NULL,
    scrape_config jsonb,
    videos_per_fetch integer DEFAULT 5,
    last_video_id text,
    last_video_published_at timestamp without time zone,
    city_slug character varying(25),
    news_source_id integer
);


--
-- Name: youtube_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.youtube_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: youtube_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.youtube_sources_id_seq OWNED BY public.youtube_sources.id;


--
-- Name: article_entities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entities ALTER COLUMN id SET DEFAULT nextval('public.article_entities_id_seq'::regclass);


--
-- Name: article_entity_mentions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entity_mentions ALTER COLUMN id SET DEFAULT nextval('public.article_entity_mentions_id_seq'::regclass);


--
-- Name: article_keywords id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_keywords ALTER COLUMN id SET DEFAULT nextval('public.article_keywords_id_seq'::regclass);


--
-- Name: article_referenced_dates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_referenced_dates ALTER COLUMN id SET DEFAULT nextval('public.article_referenced_dates_id_seq'::regclass);


--
-- Name: briefing_curation_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_curation_history ALTER COLUMN id SET DEFAULT nextval('public.briefing_curation_history_id_seq'::regclass);


--
-- Name: briefing_engagement id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_engagement ALTER COLUMN id SET DEFAULT nextval('public.briefing_engagement_id_seq'::regclass);


--
-- Name: briefing_episodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_episodes ALTER COLUMN id SET DEFAULT nextval('public.briefing_episodes_id_seq'::regclass);


--
-- Name: cities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cities ALTER COLUMN id SET DEFAULT nextval('public.cities_id_seq'::regclass);


--
-- Name: city_location_keywords id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.city_location_keywords ALTER COLUMN id SET DEFAULT nextval('public.city_location_keywords_id_seq'::regclass);


--
-- Name: cluster_edges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_edges ALTER COLUMN id SET DEFAULT nextval('public.cluster_edges_id_seq'::regclass);


--
-- Name: cluster_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_groups ALTER COLUMN id SET DEFAULT nextval('public.cluster_groups_id_seq'::regclass);


--
-- Name: cluster_nodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_nodes ALTER COLUMN id SET DEFAULT nextval('public.cluster_nodes_id_seq'::regclass);


--
-- Name: cluster_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_runs ALTER COLUMN id SET DEFAULT nextval('public.cluster_runs_id_seq'::regclass);


--
-- Name: continents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continents ALTER COLUMN id SET DEFAULT nextval('public.continents_id_seq'::regclass);


--
-- Name: countries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries ALTER COLUMN id SET DEFAULT nextval('public.countries_id_seq'::regclass);


--
-- Name: country_location_keywords id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_location_keywords ALTER COLUMN id SET DEFAULT nextval('public.country_location_keywords_id_seq'::regclass);


--
-- Name: data_panels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_panels ALTER COLUMN id SET DEFAULT nextval('public.data_panels_id_seq'::regclass);


--
-- Name: entities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities ALTER COLUMN id SET DEFAULT nextval('public.entities_id_seq'::regclass);


--
-- Name: entity_relationships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships ALTER COLUMN id SET DEFAULT nextval('public.entity_relationships_id_seq'::regclass);


--
-- Name: environmental_entity id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environmental_entity ALTER COLUMN id SET DEFAULT nextval('public.environmental_entity_id_seq'::regclass);


--
-- Name: exports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exports ALTER COLUMN id SET DEFAULT nextval('public.exports_id_seq'::regclass);


--
-- Name: heatmap_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heatmap_snapshots ALTER COLUMN id SET DEFAULT nextval('public.heatmap_snapshots_id_seq'::regclass);


--
-- Name: heatmap_ts_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heatmap_ts_snapshots ALTER COLUMN id SET DEFAULT nextval('public.heatmap_ts_snapshots_id_seq'::regclass);


--
-- Name: image_assets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_assets ALTER COLUMN id SET DEFAULT nextval('public.image_assets_id_seq'::regclass);


--
-- Name: image_usage_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage_log ALTER COLUMN id SET DEFAULT nextval('public.image_usage_log_id_seq'::regclass);


--
-- Name: imports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports ALTER COLUMN id SET DEFAULT nextval('public.imports_id_seq'::regclass);


--
-- Name: ingestion_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_runs ALTER COLUMN id SET DEFAULT nextval('public.ingestion_runs_id_seq'::regclass);


--
-- Name: keyword_backfill_progress id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_backfill_progress ALTER COLUMN id SET DEFAULT nextval('public.keyword_backfill_progress_id_seq'::regclass);


--
-- Name: keyword_daily_stats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_daily_stats ALTER COLUMN id SET DEFAULT nextval('public.keyword_daily_stats_id_seq'::regclass);


--
-- Name: keyword_intelligence_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_intelligence_cache ALTER COLUMN id SET DEFAULT nextval('public.keyword_intelligence_cache_id_seq'::regclass);


--
-- Name: keyword_tiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_tiers ALTER COLUMN id SET DEFAULT nextval('public.keyword_tiers_id_seq'::regclass);


--
-- Name: keyword_translations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_translations ALTER COLUMN id SET DEFAULT nextval('public.keyword_translations_id_seq'::regclass);


--
-- Name: keywords id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keywords ALTER COLUMN id SET DEFAULT nextval('public.keywords_id_seq'::regclass);


--
-- Name: languages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.languages ALTER COLUMN id SET DEFAULT nextval('public.languages_id_seq'::regclass);


--
-- Name: news_articles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_articles ALTER COLUMN id SET DEFAULT nextval('public.news_articles_id_seq'::regclass);


--
-- Name: news_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_sources ALTER COLUMN id SET DEFAULT nextval('public.news_sources_id_seq'::regclass);


--
-- Name: ranking_feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranking_feedback ALTER COLUMN id SET DEFAULT nextval('public.ranking_feedback_id_seq'::regclass);


--
-- Name: ranking_model_weights id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranking_model_weights ALTER COLUMN id SET DEFAULT nextval('public.ranking_model_weights_id_seq'::regclass);


--
-- Name: ranking_overrides id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranking_overrides ALTER COLUMN id SET DEFAULT nextval('public.ranking_overrides_id_seq'::regclass);


--
-- Name: regions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions ALTER COLUMN id SET DEFAULT nextval('public.regions_id_seq'::regclass);


--
-- Name: reroute_progress id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reroute_progress ALTER COLUMN id SET DEFAULT nextval('public.reroute_progress_id_seq'::regclass);


--
-- Name: rss_error_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rss_error_logs ALTER COLUMN id SET DEFAULT nextval('public.rss_error_logs_id_seq'::regclass);


--
-- Name: segment_story_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_story_links ALTER COLUMN id SET DEFAULT nextval('public.segment_story_links_id_seq'::regclass);


--
-- Name: stopwords id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stopwords ALTER COLUMN id SET DEFAULT nextval('public.stopwords_id_seq'::regclass);


--
-- Name: story_framing_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_framing_snapshots ALTER COLUMN id SET DEFAULT nextval('public.story_framing_snapshots_id_seq'::regclass);


--
-- Name: story_identities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_identities ALTER COLUMN id SET DEFAULT nextval('public.story_identities_id_seq'::regclass);


--
-- Name: story_threads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_threads ALTER COLUMN id SET DEFAULT nextval('public.story_threads_id_seq'::regclass);


--
-- Name: story_timelines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_timelines ALTER COLUMN id SET DEFAULT nextval('public.story_timelines_id_seq'::regclass);


--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);


--
-- Name: youtube_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_sources ALTER COLUMN id SET DEFAULT nextval('public.youtube_sources_id_seq'::regclass);


--
-- Name: article_entities article_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entities
    ADD CONSTRAINT article_entities_pkey PRIMARY KEY (id);


--
-- Name: article_entity_extraction_state article_entity_extraction_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entity_extraction_state
    ADD CONSTRAINT article_entity_extraction_state_pkey PRIMARY KEY (article_id);


--
-- Name: article_entity_mentions article_entity_mentions_article_id_entity_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entity_mentions
    ADD CONSTRAINT article_entity_mentions_article_id_entity_id_role_key UNIQUE (article_id, entity_id, role);


--
-- Name: article_entity_mentions article_entity_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entity_mentions
    ADD CONSTRAINT article_entity_mentions_pkey PRIMARY KEY (id);


--
-- Name: article_image_assignments article_image_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_image_assignments
    ADD CONSTRAINT article_image_assignments_pkey PRIMARY KEY (article_id);


--
-- Name: article_keywords article_keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_keywords
    ADD CONSTRAINT article_keywords_pkey PRIMARY KEY (id);


--
-- Name: article_referenced_dates article_referenced_dates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_referenced_dates
    ADD CONSTRAINT article_referenced_dates_pkey PRIMARY KEY (id);


--
-- Name: article_tags article_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_pkey PRIMARY KEY (article_id, tag_id);


--
-- Name: backfill_progress backfill_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backfill_progress
    ADD CONSTRAINT backfill_progress_pkey PRIMARY KEY (job_name);


--
-- Name: briefing_access_log briefing_access_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_access_log
    ADD CONSTRAINT briefing_access_log_pkey PRIMARY KEY (user_id, episode_id);


--
-- Name: briefing_curation_history briefing_curation_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_curation_history
    ADD CONSTRAINT briefing_curation_history_pkey PRIMARY KEY (id);


--
-- Name: briefing_engagement briefing_engagement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_engagement
    ADD CONSTRAINT briefing_engagement_pkey PRIMARY KEY (id);


--
-- Name: briefing_episodes briefing_episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_episodes
    ADD CONSTRAINT briefing_episodes_pkey PRIMARY KEY (id);


--
-- Name: briefing_episodes briefing_episodes_user_id_target_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_episodes
    ADD CONSTRAINT briefing_episodes_user_id_target_date_key UNIQUE (user_id, target_date);


--
-- Name: briefing_preferences briefing_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_preferences
    ADD CONSTRAINT briefing_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: cities cities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cities
    ADD CONSTRAINT cities_pkey PRIMARY KEY (id);


--
-- Name: cities cities_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cities
    ADD CONSTRAINT cities_slug_key UNIQUE (slug);


--
-- Name: city_location_keywords city_location_keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.city_location_keywords
    ADD CONSTRAINT city_location_keywords_pkey PRIMARY KEY (id);


--
-- Name: cluster_edges cluster_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_edges
    ADD CONSTRAINT cluster_edges_pkey PRIMARY KEY (id);


--
-- Name: cluster_edges cluster_edges_run_id_source_thread_id_target_thread_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_edges
    ADD CONSTRAINT cluster_edges_run_id_source_thread_id_target_thread_id_key UNIQUE (run_id, source_thread_id, target_thread_id);


--
-- Name: cluster_groups cluster_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_groups
    ADD CONSTRAINT cluster_groups_pkey PRIMARY KEY (id);


--
-- Name: cluster_groups cluster_groups_run_id_cluster_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_groups
    ADD CONSTRAINT cluster_groups_run_id_cluster_id_key UNIQUE (run_id, cluster_id);


--
-- Name: cluster_nodes cluster_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_nodes
    ADD CONSTRAINT cluster_nodes_pkey PRIMARY KEY (id);


--
-- Name: cluster_nodes cluster_nodes_run_id_thread_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_nodes
    ADD CONSTRAINT cluster_nodes_run_id_thread_id_key UNIQUE (run_id, thread_id);


--
-- Name: cluster_runs cluster_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_runs
    ADD CONSTRAINT cluster_runs_pkey PRIMARY KEY (id);


--
-- Name: continents continents_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continents
    ADD CONSTRAINT continents_name_key UNIQUE (name);


--
-- Name: continents continents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continents
    ADD CONSTRAINT continents_pkey PRIMARY KEY (id);


--
-- Name: continents continents_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.continents
    ADD CONSTRAINT continents_slug_key UNIQUE (slug);


--
-- Name: countries countries_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries
    ADD CONSTRAINT countries_name_key UNIQUE (name);


--
-- Name: countries countries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries
    ADD CONSTRAINT countries_pkey PRIMARY KEY (id);


--
-- Name: countries countries_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries
    ADD CONSTRAINT countries_slug_key UNIQUE (slug);


--
-- Name: country_feed_boost country_feed_boost_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_feed_boost
    ADD CONSTRAINT country_feed_boost_pkey PRIMARY KEY (country_id);


--
-- Name: country_location_keywords country_location_keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_location_keywords
    ADD CONSTRAINT country_location_keywords_pkey PRIMARY KEY (id);


--
-- Name: country_regions country_regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_regions
    ADD CONSTRAINT country_regions_pkey PRIMARY KEY (country_id, region_id);


--
-- Name: custom_briefing_usage custom_briefing_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_briefing_usage
    ADD CONSTRAINT custom_briefing_usage_pkey PRIMARY KEY (user_id, usage_month);


--
-- Name: data_panels data_panels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_panels
    ADD CONSTRAINT data_panels_pkey PRIMARY KEY (id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entities entities_wikidata_qid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_wikidata_qid_key UNIQUE (wikidata_qid);


--
-- Name: entity_event_metadata entity_event_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_event_metadata
    ADD CONSTRAINT entity_event_metadata_pkey PRIMARY KEY (entity_id);


--
-- Name: entity_relationships entity_relationships_from_entity_id_to_entity_id_relationsh_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_from_entity_id_to_entity_id_relationsh_key UNIQUE (from_entity_id, to_entity_id, relationship_type, start_date);


--
-- Name: entity_relationships entity_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_pkey PRIMARY KEY (id);


--
-- Name: environmental_entity environmental_entity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environmental_entity
    ADD CONSTRAINT environmental_entity_pkey PRIMARY KEY (id);


--
-- Name: environmental_entity environmental_entity_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environmental_entity
    ADD CONSTRAINT environmental_entity_slug_key UNIQUE (slug);


--
-- Name: exports exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exports
    ADD CONSTRAINT exports_pkey PRIMARY KEY (id);


--
-- Name: heatmap_snapshots heatmap_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heatmap_snapshots
    ADD CONSTRAINT heatmap_snapshots_pkey PRIMARY KEY (id);


--
-- Name: heatmap_snapshots heatmap_snapshots_preset_level_ref_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heatmap_snapshots
    ADD CONSTRAINT heatmap_snapshots_preset_level_ref_id_key UNIQUE (preset, level, ref_id);


--
-- Name: heatmap_ts_snapshots heatmap_ts_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heatmap_ts_snapshots
    ADD CONSTRAINT heatmap_ts_snapshots_pkey PRIMARY KEY (id);


--
-- Name: heatmap_ts_snapshots heatmap_ts_snapshots_preset_level_bucket_time_ref_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.heatmap_ts_snapshots
    ADD CONSTRAINT heatmap_ts_snapshots_preset_level_bucket_time_ref_id_key UNIQUE (preset, level, bucket_time, ref_id);


--
-- Name: image_asset_tags image_asset_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_asset_tags
    ADD CONSTRAINT image_asset_tags_pkey PRIMARY KEY (image_id, tag_id);


--
-- Name: image_assets image_assets_object_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_assets
    ADD CONSTRAINT image_assets_object_path_key UNIQUE (object_path);


--
-- Name: image_assets image_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_assets
    ADD CONSTRAINT image_assets_pkey PRIMARY KEY (id);


--
-- Name: image_assets image_assets_public_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_assets
    ADD CONSTRAINT image_assets_public_url_key UNIQUE (public_url);


--
-- Name: image_category_fallbacks image_category_fallbacks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_category_fallbacks
    ADD CONSTRAINT image_category_fallbacks_pkey PRIMARY KEY (category, fallback_category);


--
-- Name: image_usage_log image_usage_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage_log
    ADD CONSTRAINT image_usage_log_pkey PRIMARY KEY (id);


--
-- Name: imports imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_pkey PRIMARY KEY (id);


--
-- Name: ingestion_runs ingestion_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingestion_runs
    ADD CONSTRAINT ingestion_runs_pkey PRIMARY KEY (id);


--
-- Name: keyword_backfill_progress keyword_backfill_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_backfill_progress
    ADD CONSTRAINT keyword_backfill_progress_pkey PRIMARY KEY (id);


--
-- Name: keyword_daily_stats keyword_daily_stats_keyword_date_source_country_id_about_co_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_daily_stats
    ADD CONSTRAINT keyword_daily_stats_keyword_date_source_country_id_about_co_key UNIQUE (keyword, date, source_country_id, about_country_id);


--
-- Name: keyword_daily_stats keyword_daily_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_daily_stats
    ADD CONSTRAINT keyword_daily_stats_pkey PRIMARY KEY (id);


--
-- Name: keyword_intelligence_cache keyword_intelligence_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_intelligence_cache
    ADD CONSTRAINT keyword_intelligence_cache_pkey PRIMARY KEY (id);


--
-- Name: keyword_normalizations keyword_normalizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_normalizations
    ADD CONSTRAINT keyword_normalizations_pkey PRIMARY KEY (keyword);


--
-- Name: keyword_tiers keyword_tiers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_tiers
    ADD CONSTRAINT keyword_tiers_name_key UNIQUE (name);


--
-- Name: keyword_tiers keyword_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_tiers
    ADD CONSTRAINT keyword_tiers_pkey PRIMARY KEY (id);


--
-- Name: keyword_translations keyword_translations_original_keyword_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_translations
    ADD CONSTRAINT keyword_translations_original_keyword_key UNIQUE (original_keyword);


--
-- Name: keyword_translations keyword_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_translations
    ADD CONSTRAINT keyword_translations_pkey PRIMARY KEY (id);


--
-- Name: keywords keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keywords
    ADD CONSTRAINT keywords_pkey PRIMARY KEY (id);


--
-- Name: languages languages_iso_code_2_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.languages
    ADD CONSTRAINT languages_iso_code_2_key UNIQUE (iso_code_2);


--
-- Name: languages languages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.languages
    ADD CONSTRAINT languages_pkey PRIMARY KEY (id);


--
-- Name: news_articles news_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_articles
    ADD CONSTRAINT news_articles_pkey PRIMARY KEY (id);


--
-- Name: news_articles news_articles_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_articles
    ADD CONSTRAINT news_articles_url_key UNIQUE (url);


--
-- Name: news_articles news_articles_url_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_articles
    ADD CONSTRAINT news_articles_url_unique UNIQUE (url);


--
-- Name: news_sources news_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_sources
    ADD CONSTRAINT news_sources_pkey PRIMARY KEY (id);


--
-- Name: news_sources news_sources_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_sources
    ADD CONSTRAINT news_sources_slug_key UNIQUE (slug);


--
-- Name: ranking_feedback ranking_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranking_feedback
    ADD CONSTRAINT ranking_feedback_pkey PRIMARY KEY (id);


--
-- Name: ranking_model_weights ranking_model_weights_entity_type_feature_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranking_model_weights
    ADD CONSTRAINT ranking_model_weights_entity_type_feature_name_key UNIQUE (entity_type, feature_name);


--
-- Name: ranking_model_weights ranking_model_weights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranking_model_weights
    ADD CONSTRAINT ranking_model_weights_pkey PRIMARY KEY (id);


--
-- Name: ranking_overrides ranking_overrides_entity_type_entity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranking_overrides
    ADD CONSTRAINT ranking_overrides_entity_type_entity_id_key UNIQUE (entity_type, entity_id);


--
-- Name: ranking_overrides ranking_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ranking_overrides
    ADD CONSTRAINT ranking_overrides_pkey PRIMARY KEY (id);


--
-- Name: regions regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_pkey PRIMARY KEY (id);


--
-- Name: regions regions_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_slug_key UNIQUE (slug);


--
-- Name: reroute_progress reroute_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reroute_progress
    ADD CONSTRAINT reroute_progress_pkey PRIMARY KEY (id);


--
-- Name: rss_error_logs rss_error_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rss_error_logs
    ADD CONSTRAINT rss_error_logs_pkey PRIMARY KEY (id);


--
-- Name: segment_story_links segment_story_links_briefing_episode_id_segment_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_story_links
    ADD CONSTRAINT segment_story_links_briefing_episode_id_segment_index_key UNIQUE (briefing_episode_id, segment_index);


--
-- Name: segment_story_links segment_story_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_story_links
    ADD CONSTRAINT segment_story_links_pkey PRIMARY KEY (id);


--
-- Name: source_health source_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health
    ADD CONSTRAINT source_health_pkey PRIMARY KEY (source_id);


--
-- Name: source_tag_weights source_tag_weights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_tag_weights
    ADD CONSTRAINT source_tag_weights_pkey PRIMARY KEY (source_id, tag_id);


--
-- Name: stopwords stopwords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stopwords
    ADD CONSTRAINT stopwords_pkey PRIMARY KEY (id);


--
-- Name: stopwords stopwords_word_language_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stopwords
    ADD CONSTRAINT stopwords_word_language_key UNIQUE (word, language);


--
-- Name: story_framing_snapshots story_framing_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_framing_snapshots
    ADD CONSTRAINT story_framing_snapshots_pkey PRIMARY KEY (id);


--
-- Name: story_framing_snapshots story_framing_snapshots_story_identity_id_captured_at_regio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_framing_snapshots
    ADD CONSTRAINT story_framing_snapshots_story_identity_id_captured_at_regio_key UNIQUE (story_identity_id, captured_at, region);


--
-- Name: story_identities story_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_identities
    ADD CONSTRAINT story_identities_pkey PRIMARY KEY (id);


--
-- Name: story_thread_articles story_thread_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_thread_articles
    ADD CONSTRAINT story_thread_articles_pkey PRIMARY KEY (thread_id, article_id);


--
-- Name: story_thread_builder_state story_thread_builder_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_thread_builder_state
    ADD CONSTRAINT story_thread_builder_state_pkey PRIMARY KEY (key);


--
-- Name: story_threads story_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_threads
    ADD CONSTRAINT story_threads_pkey PRIMARY KEY (id);


--
-- Name: story_timeline_articles story_timeline_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_timeline_articles
    ADD CONSTRAINT story_timeline_articles_pkey PRIMARY KEY (timeline_id, article_id);


--
-- Name: story_timelines story_timelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_timelines
    ADD CONSTRAINT story_timelines_pkey PRIMARY KEY (id);


--
-- Name: story_timelines story_timelines_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_timelines
    ADD CONSTRAINT story_timelines_scope_unique UNIQUE (scope);


--
-- Name: tag_keywords tag_keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_keywords
    ADD CONSTRAINT tag_keywords_pkey PRIMARY KEY (tag_id, keyword_id);


--
-- Name: tags tags_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_key UNIQUE (name);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: cities unique_city_slug; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cities
    ADD CONSTRAINT unique_city_slug UNIQUE (slug);


--
-- Name: user_usage user_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_usage
    ADD CONSTRAINT user_usage_pkey PRIMARY KEY (user_id, usage_date);


--
-- Name: youtube_source_tag_weights youtube_source_tag_weights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_source_tag_weights
    ADD CONSTRAINT youtube_source_tag_weights_pkey PRIMARY KEY (youtube_source_id, tag_id);


--
-- Name: youtube_sources youtube_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_sources
    ADD CONSTRAINT youtube_sources_pkey PRIMARY KEY (id);


--
-- Name: youtube_sources youtube_sources_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_sources
    ADD CONSTRAINT youtube_sources_slug_key UNIQUE (slug);


--
-- Name: article_locations_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX article_locations_unique ON public.article_locations USING btree (article_id, country_id, COALESCE(city_id, '-1'::integer));


--
-- Name: data_panels_briefing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_panels_briefing_idx ON public.data_panels USING btree (scope_type, scope_id, segment_index, ord) WHERE (scope_type = 'briefing_segment'::text);


--
-- Name: data_panels_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_panels_thread_idx ON public.data_panels USING btree (scope_type, scope_id, ord) WHERE (scope_type = 'thread'::text);


--
-- Name: idx_aees_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_aees_status ON public.article_entity_extraction_state USING btree (status) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: idx_aem_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_aem_article ON public.article_entity_mentions USING btree (article_id);


--
-- Name: idx_aem_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_aem_entity ON public.article_entity_mentions USING btree (entity_id);


--
-- Name: idx_aem_historical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_aem_historical ON public.article_entity_mentions USING btree (entity_id) WHERE (role = 'referenced_historical'::text);


--
-- Name: idx_aem_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_aem_role ON public.article_entity_mentions USING btree (role);


--
-- Name: idx_ak_article_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ak_article_id ON public.article_keywords USING btree (article_id);


--
-- Name: idx_ak_extracted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ak_extracted_at ON public.article_keywords USING btree (extracted_at);


--
-- Name: idx_ak_keyword; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ak_keyword ON public.article_keywords USING btree (keyword);


--
-- Name: idx_ak_keyword_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ak_keyword_gin ON public.article_keywords USING gin (to_tsvector('simple'::regconfig, keyword));


--
-- Name: idx_ak_keyword_text; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ak_keyword_text ON public.article_keywords USING gin (to_tsvector('simple'::regconfig, keyword));


--
-- Name: idx_ak_language; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ak_language ON public.article_keywords USING btree (source_language);


--
-- Name: idx_ak_normalized; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ak_normalized ON public.article_keywords USING btree (normalized_keyword);


--
-- Name: idx_ard_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ard_article ON public.article_referenced_dates USING btree (article_id);


--
-- Name: idx_ard_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ard_date ON public.article_referenced_dates USING btree (referenced_date);


--
-- Name: idx_article_entities_article_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_entities_article_id ON public.article_entities USING btree (article_id);


--
-- Name: idx_article_entities_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_article_entities_dedup ON public.article_entities USING btree (article_id, entity_text, entity_type);


--
-- Name: idx_article_entities_type_text; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_entities_type_text ON public.article_entities USING btree (entity_type, entity_text);


--
-- Name: idx_article_image_assignments_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_image_assignments_article ON public.article_image_assignments USING btree (article_id);


--
-- Name: idx_article_image_assignments_image; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_image_assignments_image ON public.article_image_assignments USING btree (image_id);


--
-- Name: idx_article_locations_route_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_article_locations_route_article ON public.article_locations USING btree (routing_type, article_id);


--
-- Name: idx_articles_city_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_city_published ON public.news_articles USING btree (city_id, published_at DESC) WHERE (city_id IS NOT NULL);


--
-- Name: idx_articles_country_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_country_published ON public.news_articles USING btree (country_id, published_at DESC) WHERE (city_id IS NULL);


--
-- Name: idx_articles_country_source_cover; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_country_source_cover ON public.news_articles USING btree (country_id, source_id, youtube_source_id) WHERE (country_id IS NOT NULL);


--
-- Name: idx_articles_published_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_published_at ON public.news_articles USING btree (published_at DESC);


--
-- Name: idx_articles_published_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_published_city ON public.news_articles USING btree (published_at DESC, city_id) WHERE (city_id IS NOT NULL);


--
-- Name: idx_articles_published_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_published_country ON public.news_articles USING btree (published_at DESC, country_id) WHERE (country_id IS NOT NULL);


--
-- Name: idx_articles_published_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_published_source ON public.news_articles USING btree (published_at DESC, source_id, youtube_source_id);


--
-- Name: idx_articles_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_articles_source_id ON public.news_articles USING btree (source_id, published_at DESC);


--
-- Name: idx_briefing_access_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_briefing_access_ts ON public.briefing_access_log USING btree (user_id, accessed_at);


--
-- Name: idx_briefing_engagement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_briefing_engagement ON public.briefing_engagement USING btree (user_id, recorded_at DESC);


--
-- Name: idx_briefing_episodes_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_briefing_episodes_date ON public.briefing_episodes USING btree (target_date DESC, user_id);


--
-- Name: idx_briefing_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_briefing_location ON public.briefing_episodes USING btree (location_type, location_id, generated_at DESC) WHERE (location_type IS NOT NULL);


--
-- Name: idx_cities_region; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cities_region ON public.cities USING btree (region_id);


--
-- Name: idx_cluster_edges_run_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cluster_edges_run_source ON public.cluster_edges USING btree (run_id, source_thread_id);


--
-- Name: idx_cluster_edges_run_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cluster_edges_run_target ON public.cluster_edges USING btree (run_id, target_thread_id);


--
-- Name: idx_cluster_edges_run_weight; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cluster_edges_run_weight ON public.cluster_edges USING btree (run_id, weight DESC);


--
-- Name: idx_cluster_groups_run_size; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cluster_groups_run_size ON public.cluster_groups USING btree (run_id, node_count DESC, article_count DESC);


--
-- Name: idx_cluster_nodes_run_cluster; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cluster_nodes_run_cluster ON public.cluster_nodes USING btree (run_id, cluster_id);


--
-- Name: idx_cluster_nodes_run_importance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cluster_nodes_run_importance ON public.cluster_nodes USING btree (run_id, importance DESC, article_count DESC);


--
-- Name: idx_cluster_runs_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cluster_runs_lookup ON public.cluster_runs USING btree (preset, status, completed_at DESC, started_at DESC);


--
-- Name: idx_cluster_runs_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cluster_runs_window ON public.cluster_runs USING btree (window_start DESC, window_end DESC);


--
-- Name: idx_country_feed_boost_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_country_feed_boost_country ON public.country_feed_boost USING btree (country_id);


--
-- Name: idx_eem_end_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eem_end_date ON public.entity_event_metadata USING btree (end_date);


--
-- Name: idx_eem_start_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eem_start_date ON public.entity_event_metadata USING btree (start_date);


--
-- Name: idx_entities_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_active ON public.entities USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_entities_aliases_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_aliases_gin ON public.entities USING gin (aliases);


--
-- Name: idx_entities_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_name_trgm ON public.entities USING gin (canonical_name public.gin_trgm_ops);


--
-- Name: idx_entities_qid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_qid ON public.entities USING btree (wikidata_qid) WHERE (wikidata_qid IS NOT NULL);


--
-- Name: idx_entities_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entities_type ON public.entities USING btree (entity_type);


--
-- Name: idx_er_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_er_from ON public.entity_relationships USING btree (from_entity_id);


--
-- Name: idx_er_review_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_er_review_pending ON public.entity_relationships USING btree (created_at DESC) WHERE (review_status = 'unreviewed'::text);


--
-- Name: idx_er_review_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_er_review_status ON public.entity_relationships USING btree (review_status);


--
-- Name: idx_er_sources; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_er_sources ON public.entity_relationships USING gin (source_refs);


--
-- Name: idx_er_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_er_start ON public.entity_relationships USING btree (start_date);


--
-- Name: idx_er_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_er_to ON public.entity_relationships USING btree (to_entity_id);


--
-- Name: idx_er_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_er_type ON public.entity_relationships USING btree (relationship_type);


--
-- Name: idx_heatmap_snapshots_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_heatmap_snapshots_lookup ON public.heatmap_snapshots USING btree (preset, level);


--
-- Name: idx_heatmap_ts_snapshots_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_heatmap_ts_snapshots_lookup ON public.heatmap_ts_snapshots USING btree (preset, level, bucket_time);


--
-- Name: idx_image_asset_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_asset_tags_tag ON public.image_asset_tags USING btree (tag_id, image_id);


--
-- Name: idx_image_assets_active_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_assets_active_city ON public.image_assets USING btree (city_id, is_active, priority DESC, usage_count);


--
-- Name: idx_image_assets_active_country; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_assets_active_country ON public.image_assets USING btree (country_id, is_active, priority DESC, usage_count);


--
-- Name: idx_image_assets_generic_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_assets_generic_category ON public.image_assets USING btree (generic_category, is_active);


--
-- Name: idx_image_assets_keywords_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_assets_keywords_gin ON public.image_assets USING gin (keywords);


--
-- Name: idx_image_assets_primary_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_assets_primary_category ON public.image_assets USING btree (primary_category, is_active);


--
-- Name: idx_image_usage_log_article_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_usage_log_article_used_at ON public.image_usage_log USING btree (article_id, used_at DESC);


--
-- Name: idx_image_usage_log_image_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_usage_log_image_used_at ON public.image_usage_log USING btree (image_id, used_at DESC);


--
-- Name: idx_kds_about_co; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kds_about_co ON public.keyword_daily_stats USING btree (about_country_id);


--
-- Name: idx_kds_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kds_date ON public.keyword_daily_stats USING btree (date);


--
-- Name: idx_kds_global_date_kw_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kds_global_date_kw_count ON public.keyword_daily_stats USING btree (date DESC, keyword, total_count) WHERE ((source_country_id IS NULL) AND (about_country_id IS NULL));


--
-- Name: idx_kds_keyword; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kds_keyword ON public.keyword_daily_stats USING btree (keyword);


--
-- Name: idx_kds_keyword_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kds_keyword_date ON public.keyword_daily_stats USING btree (keyword, date);


--
-- Name: idx_kds_source_co; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kds_source_co ON public.keyword_daily_stats USING btree (source_country_id);


--
-- Name: idx_kic_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kic_lookup ON public.keyword_intelligence_cache USING btree (mode, filter_key, computed_at DESC);


--
-- Name: idx_kt_lang; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kt_lang ON public.keyword_translations USING btree (source_language);


--
-- Name: idx_kt_normalized; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kt_normalized ON public.keyword_translations USING btree (normalized_keyword);


--
-- Name: idx_kt_original; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kt_original ON public.keyword_translations USING btree (original_keyword);


--
-- Name: idx_news_articles_city_cluster_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_articles_city_cluster_published ON public.news_articles USING btree (city_id, published_at DESC) WHERE (city_id IS NOT NULL);


--
-- Name: idx_news_articles_country_wash_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_articles_country_wash_published ON public.news_articles USING btree (country_id, published_at DESC) WHERE ((country_id IS NOT NULL) AND (city_id IS NULL));


--
-- Name: idx_news_articles_feed_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_articles_feed_rank ON public.news_articles USING btree (base_priority DESC NULLS LAST, published_at DESC) WHERE (city_id IS NULL);


--
-- Name: idx_news_articles_global_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_articles_global_feed ON public.news_articles USING btree (published_at DESC, base_priority) WHERE (city_id IS NULL);


--
-- Name: idx_news_articles_nocity_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_articles_nocity_published ON public.news_articles USING btree (published_at DESC) WHERE (city_id IS NULL);


--
-- Name: idx_news_articles_published_at_brin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_articles_published_at_brin ON public.news_articles USING brin (published_at);


--
-- Name: idx_news_articles_published_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_articles_published_recent ON public.news_articles USING btree (published_at DESC, id) WHERE (published_at > '2026-04-03 00:00:00'::timestamp without time zone);


--
-- Name: idx_news_articles_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_articles_source_id ON public.news_articles USING btree (source_id);


--
-- Name: idx_news_articles_youtube_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_articles_youtube_source_id ON public.news_articles USING btree (youtube_source_id);


--
-- Name: idx_news_sources_fetch_bootstrap_phase; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_sources_fetch_bootstrap_phase ON public.news_sources USING btree (fetch_bootstrap_phase, last_checked_at) WHERE (is_active = true);


--
-- Name: idx_news_sources_fetch_tier_last_checked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_sources_fetch_tier_last_checked ON public.news_sources USING btree (fetch_tier, last_checked_at) WHERE (is_active = true);


--
-- Name: idx_news_sources_rss_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_sources_rss_url ON public.news_sources USING btree (rss_url);


--
-- Name: idx_ranking_feedback_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ranking_feedback_entity ON public.ranking_feedback USING btree (entity_type, entity_id, created_at DESC);


--
-- Name: idx_rss_error_logs_feed_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rss_error_logs_feed_id ON public.rss_error_logs USING btree (feed_id);


--
-- Name: idx_sfs_identity_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sfs_identity_date ON public.story_framing_snapshots USING btree (story_identity_id, captured_at DESC);


--
-- Name: idx_si_active_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_si_active_last_seen ON public.story_identities USING btree (last_seen_at DESC) WHERE (is_active = true);


--
-- Name: idx_si_keywords_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_si_keywords_gin ON public.story_identities USING gin (keywords);


--
-- Name: idx_source_health_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_health_source_id ON public.source_health USING btree (source_id);


--
-- Name: idx_source_tag_weights_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_tag_weights_source_id ON public.source_tag_weights USING btree (source_id);


--
-- Name: idx_ssl_episode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ssl_episode ON public.segment_story_links USING btree (briefing_episode_id);


--
-- Name: idx_ssl_identity_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ssl_identity_time ON public.segment_story_links USING btree (story_identity_id, linked_at DESC);


--
-- Name: idx_ssl_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ssl_thread ON public.segment_story_links USING btree (thread_id);


--
-- Name: idx_sta_anchor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sta_anchor ON public.story_timeline_articles USING btree (timeline_id) WHERE (is_anchor = true);


--
-- Name: idx_sta_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sta_article ON public.story_timeline_articles USING btree (article_id);


--
-- Name: idx_sta_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sta_timeline ON public.story_timeline_articles USING btree (timeline_id);


--
-- Name: idx_stopwords_language; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stopwords_language ON public.stopwords USING btree (language);


--
-- Name: idx_stopwords_word; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stopwords_word ON public.stopwords USING btree (word);


--
-- Name: idx_story_thread_articles_article_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_thread_articles_article_id ON public.story_thread_articles USING btree (article_id);


--
-- Name: idx_story_thread_articles_thread_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_thread_articles_thread_id ON public.story_thread_articles USING btree (thread_id);


--
-- Name: idx_story_threads_breaking_signal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_threads_breaking_signal ON public.story_threads USING btree (breaking_signal_score DESC NULLS LAST) WHERE (status = 'active'::text);


--
-- Name: idx_story_threads_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_threads_category ON public.story_threads USING btree (primary_category, status);


--
-- Name: idx_story_threads_dormant_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_threads_dormant_date ON public.story_threads USING btree (last_updated_at DESC) WHERE (status = 'dormant'::text);


--
-- Name: idx_story_threads_feed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_threads_feed ON public.story_threads USING btree (status, importance DESC, article_count DESC, last_updated_at DESC) WHERE ((article_count >= 2) AND (status = ANY (ARRAY['active'::text, 'cooling'::text, 'dormant'::text])));


--
-- Name: idx_story_threads_primary_nations_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_threads_primary_nations_gin ON public.story_threads USING gin (primary_nations);


--
-- Name: idx_story_threads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_threads_status ON public.story_threads USING btree (status, importance DESC);


--
-- Name: idx_story_threads_status_last_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_threads_status_last_updated ON public.story_threads USING btree (status, last_updated_at DESC);


--
-- Name: idx_story_threads_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_threads_updated ON public.story_threads USING btree (last_updated_at DESC);


--
-- Name: idx_story_timeline_articles_article_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_timeline_articles_article_id ON public.story_timeline_articles USING btree (article_id);


--
-- Name: idx_story_timeline_articles_timeline_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_timeline_articles_timeline_id ON public.story_timeline_articles USING btree (timeline_id);


--
-- Name: idx_story_timelines_importance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_timelines_importance ON public.story_timelines USING btree (importance DESC, last_updated_at DESC) WHERE (status = 'active'::text);


--
-- Name: idx_story_timelines_keywords_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_timelines_keywords_gin ON public.story_timelines USING gin (keywords);


--
-- Name: idx_story_timelines_primary_nations_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_timelines_primary_nations_gin ON public.story_timelines USING gin (primary_nations);


--
-- Name: idx_story_timelines_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_timelines_scope ON public.story_timelines USING btree (scope) WHERE (scope IS NOT NULL);


--
-- Name: idx_story_timelines_status_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_story_timelines_status_updated ON public.story_timelines USING btree (status, last_updated_at DESC);


--
-- Name: idx_thread_articles_article; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_thread_articles_article ON public.story_thread_articles USING btree (article_id);


--
-- Name: idx_thread_articles_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_thread_articles_thread ON public.story_thread_articles USING btree (thread_id, relevance_score DESC);


--
-- Name: idx_user_usage_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_usage_date ON public.user_usage USING btree (user_id, usage_date);


--
-- Name: idx_youtube_source_tag_weights_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_youtube_source_tag_weights_source_id ON public.youtube_source_tag_weights USING btree (youtube_source_id);


--
-- Name: keyword_normalizations_normalized_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX keyword_normalizations_normalized_idx ON public.keyword_normalizations USING btree (normalized);


--
-- Name: news_articles article_insert_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER article_insert_trigger AFTER INSERT ON public.news_articles FOR EACH ROW EXECUTE FUNCTION public.notify_new_article();


--
-- Name: news_sources trg_sync_popularity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_popularity BEFORE INSERT OR UPDATE OF popularity_tier ON public.news_sources FOR EACH ROW EXECUTE FUNCTION public.sync_popularity_score();


--
-- Name: article_entities article_entities_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entities
    ADD CONSTRAINT article_entities_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: article_entity_extraction_state article_entity_extraction_state_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entity_extraction_state
    ADD CONSTRAINT article_entity_extraction_state_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: article_entity_mentions article_entity_mentions_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entity_mentions
    ADD CONSTRAINT article_entity_mentions_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: article_entity_mentions article_entity_mentions_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_entity_mentions
    ADD CONSTRAINT article_entity_mentions_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: article_image_assignments article_image_assignments_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_image_assignments
    ADD CONSTRAINT article_image_assignments_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: article_image_assignments article_image_assignments_image_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_image_assignments
    ADD CONSTRAINT article_image_assignments_image_id_fkey FOREIGN KEY (image_id) REFERENCES public.image_assets(id) ON DELETE SET NULL;


--
-- Name: article_image_assignments article_image_assignments_matched_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_image_assignments
    ADD CONSTRAINT article_image_assignments_matched_tag_id_fkey FOREIGN KEY (matched_tag_id) REFERENCES public.tags(id) ON DELETE SET NULL;


--
-- Name: article_keywords article_keywords_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_keywords
    ADD CONSTRAINT article_keywords_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: article_locations article_locations_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_locations
    ADD CONSTRAINT article_locations_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: article_locations article_locations_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_locations
    ADD CONSTRAINT article_locations_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: article_locations article_locations_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_locations
    ADD CONSTRAINT article_locations_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id);


--
-- Name: article_referenced_dates article_referenced_dates_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_referenced_dates
    ADD CONSTRAINT article_referenced_dates_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: article_tags article_tags_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: article_tags article_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id);


--
-- Name: briefing_curation_history briefing_curation_history_episode_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_curation_history
    ADD CONSTRAINT briefing_curation_history_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES public.briefing_episodes(id) ON DELETE SET NULL;


--
-- Name: briefing_engagement briefing_engagement_episode_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_engagement
    ADD CONSTRAINT briefing_engagement_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES public.briefing_episodes(id) ON DELETE CASCADE;


--
-- Name: briefing_engagement briefing_engagement_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.briefing_engagement
    ADD CONSTRAINT briefing_engagement_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.story_threads(id) ON DELETE SET NULL;


--
-- Name: cities cities_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cities
    ADD CONSTRAINT cities_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id) ON DELETE CASCADE;


--
-- Name: cities cities_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cities
    ADD CONSTRAINT cities_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id);


--
-- Name: city_location_keywords city_location_keywords_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.city_location_keywords
    ADD CONSTRAINT city_location_keywords_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: city_location_keywords city_location_keywords_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.city_location_keywords
    ADD CONSTRAINT city_location_keywords_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id);


--
-- Name: city_location_keywords city_location_keywords_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.city_location_keywords
    ADD CONSTRAINT city_location_keywords_tier_id_fkey FOREIGN KEY (tier_id) REFERENCES public.keyword_tiers(id);


--
-- Name: cluster_edges cluster_edges_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_edges
    ADD CONSTRAINT cluster_edges_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cluster_runs(id) ON DELETE CASCADE;


--
-- Name: cluster_edges cluster_edges_source_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_edges
    ADD CONSTRAINT cluster_edges_source_thread_id_fkey FOREIGN KEY (source_thread_id) REFERENCES public.story_threads(id) ON DELETE CASCADE;


--
-- Name: cluster_edges cluster_edges_target_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_edges
    ADD CONSTRAINT cluster_edges_target_thread_id_fkey FOREIGN KEY (target_thread_id) REFERENCES public.story_threads(id) ON DELETE CASCADE;


--
-- Name: cluster_groups cluster_groups_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_groups
    ADD CONSTRAINT cluster_groups_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cluster_runs(id) ON DELETE CASCADE;


--
-- Name: cluster_nodes cluster_nodes_run_id_cluster_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_nodes
    ADD CONSTRAINT cluster_nodes_run_id_cluster_id_fkey FOREIGN KEY (run_id, cluster_id) REFERENCES public.cluster_groups(run_id, cluster_id) ON DELETE CASCADE;


--
-- Name: cluster_nodes cluster_nodes_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_nodes
    ADD CONSTRAINT cluster_nodes_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.cluster_runs(id) ON DELETE CASCADE;


--
-- Name: cluster_nodes cluster_nodes_story_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_nodes
    ADD CONSTRAINT cluster_nodes_story_identity_id_fkey FOREIGN KEY (story_identity_id) REFERENCES public.story_identities(id) ON DELETE SET NULL;


--
-- Name: cluster_nodes cluster_nodes_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_nodes
    ADD CONSTRAINT cluster_nodes_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.story_threads(id) ON DELETE CASCADE;


--
-- Name: countries countries_continent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries
    ADD CONSTRAINT countries_continent_id_fkey FOREIGN KEY (continent_id) REFERENCES public.continents(id);


--
-- Name: country_feed_boost country_feed_boost_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_feed_boost
    ADD CONSTRAINT country_feed_boost_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id);


--
-- Name: country_location_keywords country_location_keywords_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_location_keywords
    ADD CONSTRAINT country_location_keywords_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id);


--
-- Name: country_location_keywords country_location_keywords_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_location_keywords
    ADD CONSTRAINT country_location_keywords_tier_id_fkey FOREIGN KEY (tier_id) REFERENCES public.keyword_tiers(id);


--
-- Name: country_regions country_regions_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_regions
    ADD CONSTRAINT country_regions_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id) ON DELETE CASCADE;


--
-- Name: country_regions country_regions_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.country_regions
    ADD CONSTRAINT country_regions_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE CASCADE;


--
-- Name: entity_event_metadata entity_event_metadata_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_event_metadata
    ADD CONSTRAINT entity_event_metadata_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_from_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_from_entity_id_fkey FOREIGN KEY (from_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_to_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_to_entity_id_fkey FOREIGN KEY (to_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: exports exports_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exports
    ADD CONSTRAINT exports_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: exports exports_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exports
    ADD CONSTRAINT exports_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id);


--
-- Name: image_asset_tags image_asset_tags_image_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_asset_tags
    ADD CONSTRAINT image_asset_tags_image_id_fkey FOREIGN KEY (image_id) REFERENCES public.image_assets(id) ON DELETE CASCADE;


--
-- Name: image_asset_tags image_asset_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_asset_tags
    ADD CONSTRAINT image_asset_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: image_assets image_assets_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_assets
    ADD CONSTRAINT image_assets_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id) ON DELETE SET NULL;


--
-- Name: image_assets image_assets_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_assets
    ADD CONSTRAINT image_assets_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id) ON DELETE SET NULL;


--
-- Name: image_usage_log image_usage_log_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage_log
    ADD CONSTRAINT image_usage_log_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: image_usage_log image_usage_log_image_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage_log
    ADD CONSTRAINT image_usage_log_image_id_fkey FOREIGN KEY (image_id) REFERENCES public.image_assets(id) ON DELETE SET NULL;


--
-- Name: imports imports_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: imports imports_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id);


--
-- Name: keyword_daily_stats keyword_daily_stats_about_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_daily_stats
    ADD CONSTRAINT keyword_daily_stats_about_country_id_fkey FOREIGN KEY (about_country_id) REFERENCES public.countries(id) ON DELETE SET NULL;


--
-- Name: keyword_daily_stats keyword_daily_stats_source_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyword_daily_stats
    ADD CONSTRAINT keyword_daily_stats_source_country_id_fkey FOREIGN KEY (source_country_id) REFERENCES public.countries(id) ON DELETE SET NULL;


--
-- Name: news_articles news_articles_primary_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_articles
    ADD CONSTRAINT news_articles_primary_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: news_articles news_articles_primary_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_articles
    ADD CONSTRAINT news_articles_primary_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id);


--
-- Name: news_articles news_articles_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_articles
    ADD CONSTRAINT news_articles_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.news_sources(id) ON DELETE CASCADE;


--
-- Name: news_articles news_articles_youtube_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_articles
    ADD CONSTRAINT news_articles_youtube_source_id_fkey FOREIGN KEY (youtube_source_id) REFERENCES public.youtube_sources(id);


--
-- Name: news_sources news_sources_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_sources
    ADD CONSTRAINT news_sources_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: news_sources news_sources_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_sources
    ADD CONSTRAINT news_sources_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id);


--
-- Name: news_sources news_sources_language_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_sources
    ADD CONSTRAINT news_sources_language_id_fkey FOREIGN KEY (language_id) REFERENCES public.languages(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: regions regions_continent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_continent_id_fkey FOREIGN KEY (continent_id) REFERENCES public.continents(id) ON DELETE CASCADE;


--
-- Name: rss_error_logs rss_error_logs_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rss_error_logs
    ADD CONSTRAINT rss_error_logs_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.news_sources(id) ON DELETE CASCADE;


--
-- Name: segment_story_links segment_story_links_briefing_episode_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_story_links
    ADD CONSTRAINT segment_story_links_briefing_episode_id_fkey FOREIGN KEY (briefing_episode_id) REFERENCES public.briefing_episodes(id) ON DELETE CASCADE;


--
-- Name: segment_story_links segment_story_links_story_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_story_links
    ADD CONSTRAINT segment_story_links_story_identity_id_fkey FOREIGN KEY (story_identity_id) REFERENCES public.story_identities(id);


--
-- Name: segment_story_links segment_story_links_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_story_links
    ADD CONSTRAINT segment_story_links_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.story_threads(id);


--
-- Name: source_health source_health_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health
    ADD CONSTRAINT source_health_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.news_sources(id) ON DELETE CASCADE;


--
-- Name: source_tag_weights source_tag_weights_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_tag_weights
    ADD CONSTRAINT source_tag_weights_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.news_sources(id) ON DELETE CASCADE;


--
-- Name: source_tag_weights source_tag_weights_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_tag_weights
    ADD CONSTRAINT source_tag_weights_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: story_framing_snapshots story_framing_snapshots_story_identity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_framing_snapshots
    ADD CONSTRAINT story_framing_snapshots_story_identity_id_fkey FOREIGN KEY (story_identity_id) REFERENCES public.story_identities(id) ON DELETE CASCADE;


--
-- Name: story_thread_articles story_thread_articles_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_thread_articles
    ADD CONSTRAINT story_thread_articles_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: story_thread_articles story_thread_articles_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_thread_articles
    ADD CONSTRAINT story_thread_articles_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.story_threads(id) ON DELETE CASCADE;


--
-- Name: story_timeline_articles story_timeline_articles_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_timeline_articles
    ADD CONSTRAINT story_timeline_articles_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.news_articles(id) ON DELETE CASCADE;


--
-- Name: story_timeline_articles story_timeline_articles_timeline_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_timeline_articles
    ADD CONSTRAINT story_timeline_articles_timeline_id_fkey FOREIGN KEY (timeline_id) REFERENCES public.story_timelines(id) ON DELETE CASCADE;


--
-- Name: tag_keywords tag_keywords_keyword_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_keywords
    ADD CONSTRAINT tag_keywords_keyword_id_fkey FOREIGN KEY (keyword_id) REFERENCES public.keywords(id);


--
-- Name: tag_keywords tag_keywords_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_keywords
    ADD CONSTRAINT tag_keywords_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id);


--
-- Name: tag_keywords tag_keywords_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag_keywords
    ADD CONSTRAINT tag_keywords_tier_id_fkey FOREIGN KEY (tier_id) REFERENCES public.keyword_tiers(id);


--
-- Name: youtube_source_tag_weights youtube_source_tag_weights_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_source_tag_weights
    ADD CONSTRAINT youtube_source_tag_weights_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: youtube_source_tag_weights youtube_source_tag_weights_youtube_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_source_tag_weights
    ADD CONSTRAINT youtube_source_tag_weights_youtube_source_id_fkey FOREIGN KEY (youtube_source_id) REFERENCES public.youtube_sources(id) ON DELETE CASCADE;


--
-- Name: youtube_sources youtube_sources_city_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_sources
    ADD CONSTRAINT youtube_sources_city_id_fkey FOREIGN KEY (city_id) REFERENCES public.cities(id);


--
-- Name: youtube_sources youtube_sources_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_sources
    ADD CONSTRAINT youtube_sources_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id);


--
-- Name: youtube_sources youtube_sources_language_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_sources
    ADD CONSTRAINT youtube_sources_language_id_fkey FOREIGN KEY (language_id) REFERENCES public.languages(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: youtube_sources youtube_sources_news_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.youtube_sources
    ADD CONSTRAINT youtube_sources_news_source_id_fkey FOREIGN KEY (news_source_id) REFERENCES public.news_sources(id);


--
-- PostgreSQL database dump complete
--

\unrestrict 0FPOy1UASB7DQqDqQkZ3rfrewWknjWx6053inYAOZctEFQpRZzpFuxPg3c4Bt4g

