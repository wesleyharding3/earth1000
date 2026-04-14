-- Create stopwords table for keyword suggestion filtering.
-- These are common words that should not appear in keyword suggestions.

CREATE TABLE IF NOT EXISTS stopwords (
  word TEXT PRIMARY KEY
);

INSERT INTO stopwords (word) VALUES
  ('the'), ('a'), ('an'), ('and'), ('or'), ('but'), ('in'), ('on'), ('at'), ('to'),
  ('for'), ('of'), ('with'), ('by'), ('from'), ('is'), ('are'), ('was'), ('were'),
  ('be'), ('been'), ('being'), ('have'), ('has'), ('had'), ('do'), ('does'), ('did'),
  ('will'), ('would'), ('could'), ('should'), ('may'), ('might'), ('shall'), ('can'),
  ('not'), ('no'), ('nor'), ('so'), ('if'), ('then'), ('than'), ('that'), ('this'),
  ('these'), ('those'), ('it'), ('its'), ('he'), ('she'), ('they'), ('we'), ('you'),
  ('him'), ('her'), ('them'), ('us'), ('his'), ('my'), ('your'), ('our'), ('their'),
  ('me'), ('i'), ('who'), ('whom'), ('which'), ('what'), ('where'), ('when'), ('how'),
  ('why'), ('all'), ('each'), ('every'), ('both'), ('few'), ('more'), ('most'),
  ('other'), ('some'), ('such'), ('only'), ('own'), ('same'), ('too'), ('very'),
  ('just'), ('also'), ('now'), ('here'), ('there'), ('about'), ('up'), ('out'),
  ('into'), ('over'), ('after'), ('before'), ('between'), ('under'), ('again'),
  ('further'), ('once'), ('during'), ('while'), ('through'), ('above'), ('below'),
  ('any'), ('as'), ('because'), ('even'), ('get'), ('got'), ('new'), ('old'),
  ('said'), ('says'), ('say'), ('like'), ('make'), ('made'), ('many'), ('much'),
  ('still'), ('back'), ('well'), ('way'), ('one'), ('two'), ('first'), ('last'),
  ('long'), ('great'), ('little'), ('right'), ('good'), ('big'), ('high'), ('low'),
  ('small'), ('large'), ('next'), ('early'), ('young'), ('important'), ('public'),
  ('part'), ('keep'), ('let'), ('begin'), ('seem'), ('help'), ('show'), ('hear'),
  ('play'), ('run'), ('move'), ('live'), ('believe'), ('hold'), ('bring'), ('happen'),
  ('must'), ('tell'), ('provide'), ('call'), ('try'), ('ask'), ('need'), ('become'),
  ('leave'), ('put'), ('mean'), ('per'), ('via'), ('etc'), ('de'), ('la'), ('le'),
  ('el'), ('en'), ('von'), ('van'), ('di'), ('del'), ('das'), ('der'), ('die'),
  ('und'), ('est'), ('les'), ('des'), ('une'), ('que'), ('sur'), ('dans')
ON CONFLICT (word) DO NOTHING;
