-- Seed bare-word date stopwords so the keyword pipeline filters them at
-- two layers:
--   1) Extraction time (keywordExtractor.js' loadStopwords cache) — bigrams
--      involving any of these never form, so "this week" never even reaches
--      keyword_daily_stats as a single token.
--   2) Read time (keywordCron.js + the trending/rising endpoints' anti-join
--      against `stopwords`) — even if a date-token slipped through
--      extraction (e.g. ingested before the extractor was updated), it
--      still gets filtered before being served to /api/keywords/rising.
--
-- Why bare-words only: enumerating every MM/DD/YYYY × every D × every Y is
-- intractable (~37k entries per format × N formats). Numeric date strings
-- stay handled by the existing isDateLikeKeyword regex backstop on the
-- API/cron output. This migration covers the orthogonal problem: bare
-- words like "january", "monday", "2024", "tomorrow" that appear as
-- single high-frequency tokens.
--
-- All entries lowercased (extractor does `.toLowerCase()` before insert).
-- ON CONFLICT (word, language) DO NOTHING so re-running is idempotent —
-- the table already has unique (word, language) per stopwords_word_language_key.

BEGIN;

-- ── Years 1900-2100, language-agnostic ─────────────────────────────────────
-- Generated server-side from a generate_series rather than a 200-row literal.
-- 'all' applies to every language since digits are script-neutral.
INSERT INTO public.stopwords (word, language)
SELECT y::text, 'all'
FROM generate_series(1900, 2100) AS y
ON CONFLICT (word, language) DO NOTHING;

-- ── ENGLISH ────────────────────────────────────────────────────────────────
-- Months (full + abbreviations). "may" appears once — it's both the
-- full month name and an English modal verb (and arguably its own
-- abbreviation). "sept" is included alongside "sep" since both forms
-- appear in news copy.
INSERT INTO public.stopwords (word, language) VALUES
  ('january','en'),('february','en'),('march','en'),('april','en'),
  ('may','en'),('june','en'),('july','en'),('august','en'),
  ('september','en'),('october','en'),('november','en'),('december','en'),
  ('jan','en'),('feb','en'),('mar','en'),('apr','en'),
  ('jun','en'),('jul','en'),('aug','en'),
  ('sep','en'),('sept','en'),('oct','en'),('nov','en'),('dec','en'),
-- Days of week (full + abbreviations). "tues", "thur", "thurs" are
-- semi-standard alternative abbreviations that appear in copy.
  ('monday','en'),('tuesday','en'),('wednesday','en'),('thursday','en'),
  ('friday','en'),('saturday','en'),('sunday','en'),
  ('mon','en'),('tue','en'),('tues','en'),('wed','en'),
  ('thu','en'),('thur','en'),('thurs','en'),('fri','en'),('sat','en'),('sun','en'),
-- Relative date single tokens
  ('today','en'),('yesterday','en'),('tomorrow','en'),('tonight','en'),
  ('weekend','en'),('weekends','en'),('weekday','en'),('weekdays','en'),
-- Time-of-day single tokens (used as date proxies in news copy)
  ('morning','en'),('afternoon','en'),('evening','en'),('night','en'),
  ('midnight','en'),('noon','en'),('dawn','en'),('dusk','en'),
-- Compound relative phrases (bigrams). Most won't form during extraction
-- because the leading word ("this", "last", "next") is itself a common
-- stopword, but seed them anyway so the pipeline catches them at read
-- time if they ever sneak through a different ingestion path.
  ('this morning','en'),('this afternoon','en'),('this evening','en'),
  ('last night','en'),('last week','en'),('last month','en'),('last year','en'),
  ('last decade','en'),('last century','en'),
  ('next week','en'),('next month','en'),('next year','en'),
  ('next decade','en'),('next century','en')
ON CONFLICT (word, language) DO NOTHING;

-- ── SPANISH ────────────────────────────────────────────────────────────────
INSERT INTO public.stopwords (word, language) VALUES
  ('enero','es'),('febrero','es'),('marzo','es'),('abril','es'),
  ('mayo','es'),('junio','es'),('julio','es'),('agosto','es'),
  ('septiembre','es'),('setiembre','es'),
  ('octubre','es'),('noviembre','es'),('diciembre','es'),
  ('lunes','es'),('martes','es'),('miércoles','es'),('miercoles','es'),
  ('jueves','es'),('viernes','es'),('sábado','es'),('sabado','es'),('domingo','es'),
  ('hoy','es'),('ayer','es'),('mañana','es'),('manana','es'),('anoche','es')
ON CONFLICT (word, language) DO NOTHING;

-- ── FRENCH ─────────────────────────────────────────────────────────────────
INSERT INTO public.stopwords (word, language) VALUES
  ('janvier','fr'),('février','fr'),('fevrier','fr'),('mars','fr'),('avril','fr'),
  ('mai','fr'),('juin','fr'),('juillet','fr'),('août','fr'),('aout','fr'),
  ('septembre','fr'),('octobre','fr'),('novembre','fr'),('décembre','fr'),('decembre','fr'),
  ('lundi','fr'),('mardi','fr'),('mercredi','fr'),('jeudi','fr'),
  ('vendredi','fr'),('samedi','fr'),('dimanche','fr'),
  ('aujourd''hui','fr'),('hier','fr'),('demain','fr')
ON CONFLICT (word, language) DO NOTHING;

-- ── GERMAN ─────────────────────────────────────────────────────────────────
-- Lowercase entries — German capitalises nouns but the keyword extractor
-- lowercases before storage, so "Januar" arrives as "januar".
INSERT INTO public.stopwords (word, language) VALUES
  ('januar','de'),('februar','de'),('märz','de'),('marz','de'),('april','de'),
  ('mai','de'),('juni','de'),('juli','de'),('august','de'),
  ('september','de'),('oktober','de'),('november','de'),('dezember','de'),
  ('montag','de'),('dienstag','de'),('mittwoch','de'),('donnerstag','de'),
  ('freitag','de'),('samstag','de'),('sonnabend','de'),('sonntag','de'),
  ('heute','de'),('gestern','de'),('morgen','de'),('uebermorgen','de'),('übermorgen','de')
ON CONFLICT (word, language) DO NOTHING;

-- ── ITALIAN ────────────────────────────────────────────────────────────────
INSERT INTO public.stopwords (word, language) VALUES
  ('gennaio','it'),('febbraio','it'),('marzo','it'),('aprile','it'),
  ('maggio','it'),('giugno','it'),('luglio','it'),('agosto','it'),
  ('settembre','it'),('ottobre','it'),('novembre','it'),('dicembre','it'),
  ('lunedì','it'),('lunedi','it'),('martedì','it'),('martedi','it'),
  ('mercoledì','it'),('mercoledi','it'),('giovedì','it'),('giovedi','it'),
  ('venerdì','it'),('venerdi','it'),('sabato','it'),('domenica','it'),
  ('oggi','it'),('ieri','it'),('domani','it')
ON CONFLICT (word, language) DO NOTHING;

-- ── PORTUGUESE ─────────────────────────────────────────────────────────────
INSERT INTO public.stopwords (word, language) VALUES
  ('janeiro','pt'),('fevereiro','pt'),('março','pt'),('marco','pt'),('abril','pt'),
  ('maio','pt'),('junho','pt'),('julho','pt'),('agosto','pt'),
  ('setembro','pt'),('outubro','pt'),('novembro','pt'),('dezembro','pt'),
  ('segunda','pt'),('terça','pt'),('terca','pt'),('quarta','pt'),('quinta','pt'),
  ('sexta','pt'),('sábado','pt'),('sabado','pt'),('domingo','pt'),
  ('hoje','pt'),('ontem','pt'),('amanhã','pt'),('amanha','pt')
ON CONFLICT (word, language) DO NOTHING;

-- ── RUSSIAN ────────────────────────────────────────────────────────────────
-- Russian dates use genitive case in formats like "15 января" (15th of
-- January), so we seed both nominative ("январь") and genitive ("января").
-- Day names are already nominative in dates.
INSERT INTO public.stopwords (word, language) VALUES
  ('январь','ru'),('февраль','ru'),('март','ru'),('апрель','ru'),
  ('май','ru'),('июнь','ru'),('июль','ru'),('август','ru'),
  ('сентябрь','ru'),('октябрь','ru'),('ноябрь','ru'),('декабрь','ru'),
  ('января','ru'),('февраля','ru'),('марта','ru'),('апреля','ru'),
  ('мая','ru'),('июня','ru'),('июля','ru'),('августа','ru'),
  ('сентября','ru'),('октября','ru'),('ноября','ru'),('декабря','ru'),
  ('понедельник','ru'),('вторник','ru'),('среда','ru'),('четверг','ru'),
  ('пятница','ru'),('суббота','ru'),('воскресенье','ru'),
  ('сегодня','ru'),('вчера','ru'),('завтра','ru')
ON CONFLICT (word, language) DO NOTHING;

-- ── CHINESE (Simplified + Traditional) ─────────────────────────────────────
-- Months in Chinese use the form "1月", "2月" etc. — those are 2 chars and
-- below the keyword extractor's MIN_WORD_LEN=3, so they'd be filtered at
-- extraction. Seed the 3-char "十一月" and "十二月" forms anyway. Plus the
-- character-name forms ("一月" through "十二月") that appear in copy.
INSERT INTO public.stopwords (word, language) VALUES
  ('一月','zh'),('二月','zh'),('三月','zh'),('四月','zh'),
  ('五月','zh'),('六月','zh'),('七月','zh'),('八月','zh'),
  ('九月','zh'),('十月','zh'),('十一月','zh'),('十二月','zh'),
  ('星期一','zh'),('星期二','zh'),('星期三','zh'),('星期四','zh'),
  ('星期五','zh'),('星期六','zh'),('星期日','zh'),('星期天','zh'),
  ('周一','zh'),('周二','zh'),('周三','zh'),('周四','zh'),
  ('周五','zh'),('周六','zh'),('周日','zh'),
  ('今天','zh'),('昨天','zh'),('明天','zh'),('前天','zh'),('后天','zh'),
  ('今日','zh'),('昨日','zh'),('明日','zh')
ON CONFLICT (word, language) DO NOTHING;

-- ── JAPANESE ───────────────────────────────────────────────────────────────
-- Day names: 月曜日 / 火曜日 etc. (3 chars, pass extractor's length check).
-- Months overlap with Chinese forms above; seed them under 'ja' too since
-- the keyword extractor's stopwords lookup is keyed by language.
INSERT INTO public.stopwords (word, language) VALUES
  ('一月','ja'),('二月','ja'),('三月','ja'),('四月','ja'),
  ('五月','ja'),('六月','ja'),('七月','ja'),('八月','ja'),
  ('九月','ja'),('十月','ja'),('十一月','ja'),('十二月','ja'),
  ('月曜日','ja'),('火曜日','ja'),('水曜日','ja'),('木曜日','ja'),
  ('金曜日','ja'),('土曜日','ja'),('日曜日','ja'),
  ('今日','ja'),('昨日','ja'),('明日','ja'),('一昨日','ja'),('明後日','ja')
ON CONFLICT (word, language) DO NOTHING;

-- ── KOREAN ─────────────────────────────────────────────────────────────────
-- Numeric+월 month forms (1월, 2월…) are 2 chars and filtered at extraction.
-- Seed the 3+char day-of-week forms.
INSERT INTO public.stopwords (word, language) VALUES
  ('월요일','ko'),('화요일','ko'),('수요일','ko'),('목요일','ko'),
  ('금요일','ko'),('토요일','ko'),('일요일','ko'),
  ('오늘','ko'),('어제','ko'),('내일','ko'),('모레','ko'),('그제','ko')
ON CONFLICT (word, language) DO NOTHING;

-- ── ARABIC ─────────────────────────────────────────────────────────────────
-- Month names (Gregorian). The Levant calendar uses different names
-- (كانون الثاني for January, etc.) — common enough to seed both sets.
INSERT INTO public.stopwords (word, language) VALUES
  ('يناير','ar'),('فبراير','ar'),('مارس','ar'),('أبريل','ar'),('ابريل','ar'),
  ('مايو','ar'),('يونيو','ar'),('يوليو','ar'),('أغسطس','ar'),('اغسطس','ar'),
  ('سبتمبر','ar'),('أكتوبر','ar'),('اكتوبر','ar'),('نوفمبر','ar'),('ديسمبر','ar'),
-- Days
  ('الاثنين','ar'),('الإثنين','ar'),('الثلاثاء','ar'),('الأربعاء','ar'),('الاربعاء','ar'),
  ('الخميس','ar'),('الجمعة','ar'),('السبت','ar'),('الأحد','ar'),('الاحد','ar'),
  ('اليوم','ar'),('أمس','ar'),('امس','ar'),('غدا','ar'),('غداً','ar')
ON CONFLICT (word, language) DO NOTHING;

-- ── HINDI ──────────────────────────────────────────────────────────────────
INSERT INTO public.stopwords (word, language) VALUES
  ('जनवरी','hi'),('फरवरी','hi'),('मार्च','hi'),('अप्रैल','hi'),
  ('मई','hi'),('जून','hi'),('जुलाई','hi'),('अगस्त','hi'),
  ('सितंबर','hi'),('अक्टूबर','hi'),('नवंबर','hi'),('दिसंबर','hi'),
  ('सोमवार','hi'),('मंगलवार','hi'),('बुधवार','hi'),('गुरुवार','hi'),
  ('शुक्रवार','hi'),('शनिवार','hi'),('रविवार','hi'),
  ('आज','hi'),('कल','hi'),('परसों','hi')
ON CONFLICT (word, language) DO NOTHING;

-- ── DUTCH ──────────────────────────────────────────────────────────────────
INSERT INTO public.stopwords (word, language) VALUES
  ('januari','nl'),('februari','nl'),('maart','nl'),('april','nl'),
  ('mei','nl'),('juni','nl'),('juli','nl'),('augustus','nl'),
  ('september','nl'),('oktober','nl'),('november','nl'),('december','nl'),
  ('maandag','nl'),('dinsdag','nl'),('woensdag','nl'),('donderdag','nl'),
  ('vrijdag','nl'),('zaterdag','nl'),('zondag','nl'),
  ('vandaag','nl'),('gisteren','nl'),('morgen','nl')
ON CONFLICT (word, language) DO NOTHING;

-- ── POLISH ─────────────────────────────────────────────────────────────────
INSERT INTO public.stopwords (word, language) VALUES
  ('styczeń','pl'),('styczen','pl'),('luty','pl'),('marzec','pl'),('kwiecień','pl'),('kwiecien','pl'),
  ('maj','pl'),('czerwiec','pl'),('lipiec','pl'),('sierpień','pl'),('sierpien','pl'),
  ('wrzesień','pl'),('wrzesien','pl'),('październik','pl'),('pazdziernik','pl'),
  ('listopad','pl'),('grudzień','pl'),('grudzien','pl'),
  ('poniedziałek','pl'),('poniedzialek','pl'),('wtorek','pl'),('środa','pl'),('sroda','pl'),
  ('czwartek','pl'),('piątek','pl'),('piatek','pl'),('sobota','pl'),('niedziela','pl'),
  ('dzisiaj','pl'),('wczoraj','pl'),('jutro','pl')
ON CONFLICT (word, language) DO NOTHING;

-- ── TURKISH ────────────────────────────────────────────────────────────────
INSERT INTO public.stopwords (word, language) VALUES
  ('ocak','tr'),('şubat','tr'),('subat','tr'),('mart','tr'),('nisan','tr'),
  ('mayıs','tr'),('mayis','tr'),('haziran','tr'),('temmuz','tr'),('ağustos','tr'),('agustos','tr'),
  ('eylül','tr'),('eylul','tr'),('ekim','tr'),('kasım','tr'),('kasim','tr'),('aralık','tr'),('aralik','tr'),
  ('pazartesi','tr'),('salı','tr'),('sali','tr'),('çarşamba','tr'),('carsamba','tr'),
  ('perşembe','tr'),('persembe','tr'),('cuma','tr'),('cumartesi','tr'),('pazar','tr'),
  ('bugün','tr'),('bugun','tr'),('dün','tr'),('dun','tr'),('yarın','tr'),('yarin','tr')
ON CONFLICT (word, language) DO NOTHING;

COMMIT;

-- ── Post-migration verification ────────────────────────────────────────────
-- After running, confirm coverage with:
--   SELECT language, COUNT(*) FROM stopwords
--    WHERE word ~ '^(19|20)\d{2}$' OR word IN
--          ('january','monday','today','enero','lundi','januar','январь','一月')
--    GROUP BY language ORDER BY language;
