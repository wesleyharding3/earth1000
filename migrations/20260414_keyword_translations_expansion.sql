-- Expanded keyword translations for multilingual autocomplete support
-- Covers: tariffs, bigram concepts, geopolitical entities, conflict/military,
-- economic/trade, humanitarian/social, environment/energy, tech/cyber, political, health
--
-- Uses ON CONFLICT to skip duplicates already present from Claude-based extraction.

INSERT INTO keyword_translations (original_keyword, normalized_keyword, confidence)
VALUES

-- ═══════════════════════════════════════════════════════════════
-- 1. TARIFF (was missing translations entirely)
-- ═══════════════════════════════════════════════════════════════
('arancel', 'tariff', 1.0),
('aranceles', 'tariffs', 1.0),
('tarif douanier', 'tariff', 1.0),
('droits de douane', 'tariffs', 1.0),
('تعريفة', 'tariff', 1.0),
('رسوم جمركية', 'tariffs', 1.0),
('тариф', 'tariff', 1.0),
('пошлина', 'tariff', 1.0),
('пошлины', 'tariffs', 1.0),
('таможенные пошлины', 'tariffs', 1.0),
('zoll', 'tariff', 1.0),
('zölle', 'tariffs', 1.0),
('tarifa', 'tariff', 1.0),
('tarifas', 'tariffs', 1.0),
('gümrük vergisi', 'tariff', 1.0),
('gümrük vergileri', 'tariffs', 1.0),
('关税', 'tariff', 1.0),
('関税', 'tariff', 1.0),
('관세', 'tariff', 1.0),
('मीता', 'tariff', 1.0),
('dazio', 'tariff', 1.0),
('dazi', 'tariffs', 1.0),
('cło', 'tariff', 1.0),
('cła', 'tariffs', 1.0),
('мито', 'tariff', 1.0),
('мита', 'tariffs', 1.0),
('تعرفه', 'tariff', 1.0),
('thuế quan', 'tariff', 1.0),
('δασμός', 'tariff', 1.0),
('δασμοί', 'tariffs', 1.0),

-- ═══════════════════════════════════════════════════════════════
-- 2. BIGRAM CONCEPTS
-- ═══════════════════════════════════════════════════════════════

-- trade war
('guerra comercial', 'trade war', 1.0),
('guerre commerciale', 'trade war', 1.0),
('حرب تجارية', 'trade war', 1.0),
('торговая война', 'trade war', 1.0),
('handelskrieg', 'trade war', 1.0),
('ticaret savaşı', 'trade war', 1.0),
('贸易战', 'trade war', 1.0),
('貿易戦争', 'trade war', 1.0),
('무역전쟁', 'trade war', 1.0),
('व्यापार युद्ध', 'trade war', 1.0),
('guerra commerciale', 'trade war', 1.0),
('wojna handlowa', 'trade war', 1.0),
('торговельна війна', 'trade war', 1.0),
('جنگ تجاری', 'trade war', 1.0),
('εμπορικός πόλεμος', 'trade war', 1.0),
('chiến tranh thương mại', 'trade war', 1.0),

-- human rights
('derechos humanos', 'human rights', 1.0),
('droits de l''homme', 'human rights', 1.0),
('حقوق الإنسان', 'human rights', 1.0),
('права человека', 'human rights', 1.0),
('menschenrechte', 'human rights', 1.0),
('direitos humanos', 'human rights', 1.0),
('insan hakları', 'human rights', 1.0),
('人权', 'human rights', 1.0),
('人権', 'human rights', 1.0),
('인권', 'human rights', 1.0),
('मानवाधिकार', 'human rights', 1.0),
('diritti umani', 'human rights', 1.0),
('prawa człowieka', 'human rights', 1.0),
('права людини', 'human rights', 1.0),
('حقوق بشر', 'human rights', 1.0),
('ανθρώπινα δικαιώματα', 'human rights', 1.0),
('quyền con người', 'human rights', 1.0),

-- climate change
('cambio climático', 'climate change', 1.0),
('changement climatique', 'climate change', 1.0),
('تغير المناخ', 'climate change', 1.0),
('изменение климата', 'climate change', 1.0),
('klimawandel', 'climate change', 1.0),
('mudança climática', 'climate change', 1.0),
('iklim değişikliği', 'climate change', 1.0),
('气候变化', 'climate change', 1.0),
('気候変動', 'climate change', 1.0),
('기후변화', 'climate change', 1.0),
('जलवायु परिवर्तन', 'climate change', 1.0),
('cambiamento climatico', 'climate change', 1.0),
('zmiana klimatu', 'climate change', 1.0),
('зміна клімату', 'climate change', 1.0),
('تغییرات اقلیمی', 'climate change', 1.0),
('κλιματική αλλαγή', 'climate change', 1.0),
('biến đổi khí hậu', 'climate change', 1.0),

-- interest rate
('tasa de interés', 'interest rate', 1.0),
('taux d''intérêt', 'interest rate', 1.0),
('سعر الفائدة', 'interest rate', 1.0),
('процентная ставка', 'interest rate', 1.0),
('zinssatz', 'interest rate', 1.0),
('taxa de juros', 'interest rate', 1.0),
('faiz oranı', 'interest rate', 1.0),
('利率', 'interest rate', 1.0),
('金利', 'interest rate', 1.0),
('금리', 'interest rate', 1.0),
('ब्याज दर', 'interest rate', 1.0),
('tasso di interesse', 'interest rate', 1.0),
('stopa procentowa', 'interest rate', 1.0),
('відсоткова ставка', 'interest rate', 1.0),

-- supply chain
('cadena de suministro', 'supply chain', 1.0),
('chaîne d''approvisionnement', 'supply chain', 1.0),
('سلسلة التوريد', 'supply chain', 1.0),
('цепочка поставок', 'supply chain', 1.0),
('lieferkette', 'supply chain', 1.0),
('cadeia de suprimentos', 'supply chain', 1.0),
('tedarik zinciri', 'supply chain', 1.0),
('供应链', 'supply chain', 1.0),
('サプライチェーン', 'supply chain', 1.0),
('공급망', 'supply chain', 1.0),

-- artificial intelligence
('inteligencia artificial', 'artificial intelligence', 1.0),
('intelligence artificielle', 'artificial intelligence', 1.0),
('الذكاء الاصطناعي', 'artificial intelligence', 1.0),
('искусственный интеллект', 'artificial intelligence', 1.0),
('künstliche intelligenz', 'artificial intelligence', 1.0),
('inteligência artificial', 'artificial intelligence', 1.0),
('yapay zeka', 'artificial intelligence', 1.0),
('人工智能', 'artificial intelligence', 1.0),
('人工知能', 'artificial intelligence', 1.0),
('인공지능', 'artificial intelligence', 1.0),
('कृत्रिम बुद्धिमत्ता', 'artificial intelligence', 1.0),
('intelligenza artificiale', 'artificial intelligence', 1.0),
('sztuczna inteligencja', 'artificial intelligence', 1.0),
('штучний інтелект', 'artificial intelligence', 1.0),
('هوش مصنوعی', 'artificial intelligence', 1.0),
('τεχνητή νοημοσύνη', 'artificial intelligence', 1.0),
('trí tuệ nhân tạo', 'artificial intelligence', 1.0),

-- natural disaster
('desastre natural', 'natural disaster', 1.0),
('catastrophe naturelle', 'natural disaster', 1.0),
('كارثة طبيعية', 'natural disaster', 1.0),
('стихийное бедствие', 'natural disaster', 1.0),
('naturkatastrophe', 'natural disaster', 1.0),
('doğal afet', 'natural disaster', 1.0),
('自然灾害', 'natural disaster', 1.0),
('自然災害', 'natural disaster', 1.0),
('자연재해', 'natural disaster', 1.0),
('प्राकृतिक आपदा', 'natural disaster', 1.0),
('catastrofe naturale', 'natural disaster', 1.0),
('klęska żywiołowa', 'natural disaster', 1.0),
('стихійне лихо', 'natural disaster', 1.0),

-- war crimes
('crímenes de guerra', 'war crimes', 1.0),
('crimes de guerre', 'war crimes', 1.0),
('جرائم حرب', 'war crimes', 1.0),
('военные преступления', 'war crimes', 1.0),
('kriegsverbrechen', 'war crimes', 1.0),
('crimes de guerra', 'war crimes', 1.0),
('savaş suçları', 'war crimes', 1.0),
('战争罪', 'war crimes', 1.0),
('戦争犯罪', 'war crimes', 1.0),
('전쟁범죄', 'war crimes', 1.0),
('युद्ध अपराध', 'war crimes', 1.0),
('crimini di guerra', 'war crimes', 1.0),
('zbrodnie wojenne', 'war crimes', 1.0),
('воєнні злочини', 'war crimes', 1.0),

-- arms deal
('acuerdo de armas', 'arms deal', 1.0),
('accord sur les armes', 'arms deal', 1.0),
('صفقة أسلحة', 'arms deal', 1.0),
('оружейная сделка', 'arms deal', 1.0),
('waffengeschäft', 'arms deal', 1.0),
('acordo de armas', 'arms deal', 1.0),
('silah anlaşması', 'arms deal', 1.0),
('军售', 'arms deal', 1.0),
('武器取引', 'arms deal', 1.0),

-- government change
('cambio de régimen', 'government change', 1.0),
('changement de régime', 'government change', 1.0),
('تغيير النظام', 'government change', 1.0),
('смена режима', 'government change', 1.0),
('regimewechsel', 'government change', 1.0),
('mudança de regime', 'government change', 1.0),
('rejim değişikliği', 'government change', 1.0),
('政权更迭', 'government change', 1.0),

-- ═══════════════════════════════════════════════════════════════
-- 3. GEOPOLITICAL ENTITIES
-- ═══════════════════════════════════════════════════════════════

-- NATO
('otan', 'nato', 1.0),
('الناتو', 'nato', 1.0),
('حلف الناتو', 'nato', 1.0),
('حلف شمال الأطلسي', 'nato', 1.0),
('нато', 'nato', 1.0),
('北约', 'nato', 1.0),
('北大西洋条約機構', 'nato', 1.0),
('나토', 'nato', 1.0),

-- BRICS
('брикс', 'brics', 1.0),
('بريكس', 'brics', 1.0),
('金砖国家', 'brics', 1.0),

-- OPEC
('опек', 'opec', 1.0),
('أوبك', 'opec', 1.0),
('석유수출국기구', 'opec', 1.0),
('欧佩克', 'opec', 1.0),

-- WHO / World Health Organization
('oms', 'who', 1.0),
('منظمة الصحة العالمية', 'who', 1.0),
('воз', 'who', 1.0),
('世界卫生组织', 'who', 1.0),
('世界保健機関', 'who', 1.0),
('세계보건기구', 'who', 1.0),

-- IMF
('fmi', 'imf', 1.0),
('صندوق النقد الدولي', 'imf', 1.0),
('мвф', 'imf', 1.0),
('国际货币基金组织', 'imf', 1.0),
('国際通貨基金', 'imf', 1.0),
('국제통화기금', 'imf', 1.0),

-- European Union
('unión europea', 'european union', 1.0),
('union européenne', 'european union', 1.0),
('الاتحاد الأوروبي', 'european union', 1.0),
('европейский союз', 'european union', 1.0),
('europäische union', 'european union', 1.0),
('união europeia', 'european union', 1.0),
('avrupa birliği', 'european union', 1.0),
('欧盟', 'european union', 1.0),
('欧州連合', 'european union', 1.0),
('유럽연합', 'european union', 1.0),
('unione europea', 'european union', 1.0),
('unia europejska', 'european union', 1.0),
('європейський союз', 'european union', 1.0),
('اتحادیه اروپا', 'european union', 1.0),

-- United Nations
('naciones unidas', 'united nations', 1.0),
('nations unies', 'united nations', 1.0),
('الأمم المتحدة', 'united nations', 1.0),
('организация объединённых наций', 'united nations', 1.0),
('vereinte nationen', 'united nations', 1.0),
('nações unidas', 'united nations', 1.0),
('birleşmiş milletler', 'united nations', 1.0),
('联合国', 'united nations', 1.0),
('国際連合', 'united nations', 1.0),
('국제연합', 'united nations', 1.0),
('nazioni unite', 'united nations', 1.0),
('narody zjednoczone', 'united nations', 1.0),
('організація об''єднаних націй', 'united nations', 1.0),
('سازمان ملل متحد', 'united nations', 1.0),
('ηνωμένα έθνη', 'united nations', 1.0),
('liên hợp quốc', 'united nations', 1.0),

-- Hamas
('حماس', 'hamas', 1.0),
('хамас', 'hamas', 1.0),
('하마스', 'hamas', 1.0),
('ハマス', 'hamas', 1.0),

-- Hezbollah
('حزب الله', 'hezbollah', 1.0),
('хезболла', 'hezbollah', 1.0),
('히즈볼라', 'hezbollah', 1.0),
('ヒズボラ', 'hezbollah', 1.0),

-- Wagner
('вагнер', 'wagner', 1.0),
('فاغنر', 'wagner', 1.0),
('바그너', 'wagner', 1.0),

-- Houthi
('الحوثي', 'houthi', 1.0),
('الحوثيين', 'houthi', 1.0),
('хуситы', 'houthi', 1.0),
('후티', 'houthi', 1.0),

-- ═══════════════════════════════════════════════════════════════
-- 4. CONFLICT / MILITARY
-- ═══════════════════════════════════════════════════════════════

-- airstrike
('ataque aéreo', 'airstrike', 1.0),
('frappe aérienne', 'airstrike', 1.0),
('غارة جوية', 'airstrike', 1.0),
('авиаудар', 'airstrike', 1.0),
('luftangriff', 'airstrike', 1.0),
('hava saldırısı', 'airstrike', 1.0),
('空袭', 'airstrike', 1.0),
('空爆', 'airstrike', 1.0),
('공습', 'airstrike', 1.0),
('हवाई हमला', 'airstrike', 1.0),
('attacco aereo', 'airstrike', 1.0),
('авіаудар', 'airstrike', 1.0),

-- occupation
('ocupación', 'occupation', 1.0),
('الاحتلال', 'occupation', 1.0),
('оккупация', 'occupation', 1.0),
('besatzung', 'occupation', 1.0),
('ocupação', 'occupation', 1.0),
('işgal', 'occupation', 1.0),
('占领', 'occupation', 1.0),
('占領', 'occupation', 1.0),
('점령', 'occupation', 1.0),
('окупація', 'occupation', 1.0),
('اشغال', 'occupation', 1.0),
('κατοχή', 'occupation', 1.0),

-- insurgency
('insurgencia', 'insurgency', 1.0),
('insurrection', 'insurgency', 1.0),
('تمرد', 'insurgency', 1.0),
('повстанческое движение', 'insurgency', 1.0),
('aufstand', 'insurgency', 1.0),
('insurgência', 'insurgency', 1.0),
('isyan', 'insurgency', 1.0),
('叛乱', 'insurgency', 1.0),

-- militia
('milicia', 'militia', 1.0),
('milice', 'militia', 1.0),
('ميليشيا', 'militia', 1.0),
('ополчение', 'militia', 1.0),
('miliz', 'militia', 1.0),
('milícia', 'militia', 1.0),
('milis', 'militia', 1.0),
('民兵', 'militia', 1.0),

-- drone strike
('ataque con dron', 'drone strike', 1.0),
('frappe de drone', 'drone strike', 1.0),
('هجوم بطائرة مسيرة', 'drone strike', 1.0),
('удар беспилотника', 'drone strike', 1.0),
('drohnenangriff', 'drone strike', 1.0),
('ataque de drone', 'drone strike', 1.0),
('无人机袭击', 'drone strike', 1.0),
('드론공격', 'drone strike', 1.0),

-- hostage
('rehén', 'hostage', 1.0),
('otage', 'hostage', 1.0),
('رهينة', 'hostage', 1.0),
('رهائن', 'hostage', 1.0),
('заложник', 'hostage', 1.0),
('заложники', 'hostage', 1.0),
('geisel', 'hostage', 1.0),
('refém', 'hostage', 1.0),
('rehine', 'hostage', 1.0),
('人质', 'hostage', 1.0),
('人質', 'hostage', 1.0),
('인질', 'hostage', 1.0),
('बंधक', 'hostage', 1.0),
('ostaggio', 'hostage', 1.0),
('заручник', 'hostage', 1.0),
('όμηρος', 'hostage', 1.0),

-- blockade
('bloqueo', 'blockade', 1.0),
('blocus', 'blockade', 1.0),
('حصار', 'blockade', 1.0),
('блокада', 'blockade', 1.0),
('blockade', 'blockade', 1.0),
('bloqueio', 'blockade', 1.0),
('abluka', 'blockade', 1.0),
('封锁', 'blockade', 1.0),
('封鎖', 'blockade', 1.0),
('봉쇄', 'blockade', 1.0),
('αποκλεισμός', 'blockade', 1.0),

-- arms race
('carrera armamentista', 'arms race', 1.0),
('course aux armements', 'arms race', 1.0),
('سباق تسلح', 'arms race', 1.0),
('гонка вооружений', 'arms race', 1.0),
('wettrüsten', 'arms race', 1.0),
('corrida armamentista', 'arms race', 1.0),
('silahlanma yarışı', 'arms race', 1.0),
('军备竞赛', 'arms race', 1.0),
('군비경쟁', 'arms race', 1.0),

-- ═══════════════════════════════════════════════════════════════
-- 5. ECONOMIC / TRADE
-- ═══════════════════════════════════════════════════════════════

-- debt
('deuda', 'debt', 1.0),
('dette', 'debt', 1.0),
('دين', 'debt', 1.0),
('ديون', 'debt', 1.0),
('долг', 'debt', 1.0),
('schulden', 'debt', 1.0),
('dívida', 'debt', 1.0),
('borç', 'debt', 1.0),
('债务', 'debt', 1.0),
('負債', 'debt', 1.0),
('부채', 'debt', 1.0),
('ऋण', 'debt', 1.0),
('debito', 'debt', 1.0),
('dług', 'debt', 1.0),
('борг', 'debt', 1.0),
('χρέος', 'debt', 1.0),

-- subsidy / subsidies
('subsidio', 'subsidy', 1.0),
('subvention', 'subsidy', 1.0),
('إعانة', 'subsidy', 1.0),
('دعم', 'subsidy', 1.0),
('субсидия', 'subsidy', 1.0),
('субсидии', 'subsidies', 1.0),
('subsídio', 'subsidy', 1.0),
('sübvansiyon', 'subsidy', 1.0),
('补贴', 'subsidy', 1.0),
('補助金', 'subsidy', 1.0),
('보조금', 'subsidy', 1.0),
('सब्सिडी', 'subsidy', 1.0),

-- currency
('moneda', 'currency', 1.0),
('devise', 'currency', 1.0),
('عملة', 'currency', 1.0),
('валюта', 'currency', 1.0),
('währung', 'currency', 1.0),
('moeda', 'currency', 1.0),
('para birimi', 'currency', 1.0),
('货币', 'currency', 1.0),
('通貨', 'currency', 1.0),
('통화', 'currency', 1.0),
('मुद्रा', 'currency', 1.0),
('valuta', 'currency', 1.0),
('waluta', 'currency', 1.0),
('νόμισμα', 'currency', 1.0),

-- unemployment
('desempleo', 'unemployment', 1.0),
('chômage', 'unemployment', 1.0),
('بطالة', 'unemployment', 1.0),
('безработица', 'unemployment', 1.0),
('arbeitslosigkeit', 'unemployment', 1.0),
('desemprego', 'unemployment', 1.0),
('işsizlik', 'unemployment', 1.0),
('失业', 'unemployment', 1.0),
('失業', 'unemployment', 1.0),
('실업', 'unemployment', 1.0),
('बेरोजगारी', 'unemployment', 1.0),
('disoccupazione', 'unemployment', 1.0),
('bezrobocie', 'unemployment', 1.0),
('безробіття', 'unemployment', 1.0),

-- stock market
('bolsa de valores', 'stock market', 1.0),
('bourse', 'stock market', 1.0),
('سوق الأسهم', 'stock market', 1.0),
('البورصة', 'stock market', 1.0),
('фондовый рынок', 'stock market', 1.0),
('börse', 'stock market', 1.0),
('borsa', 'stock market', 1.0),
('股市', 'stock market', 1.0),
('株式市場', 'stock market', 1.0),
('주식시장', 'stock market', 1.0),

-- commodity
('materia prima', 'commodity', 1.0),
('matière première', 'commodity', 1.0),
('سلعة', 'commodity', 1.0),
('сырьевой товар', 'commodity', 1.0),
('rohstoff', 'commodity', 1.0),
('commodity', 'commodity', 1.0),
('emtia', 'commodity', 1.0),
('大宗商品', 'commodity', 1.0),
('商品', 'commodity', 1.0),
('원자재', 'commodity', 1.0),

-- austerity
('austeridad', 'austerity', 1.0),
('austérité', 'austerity', 1.0),
('تقشف', 'austerity', 1.0),
('жёсткая экономия', 'austerity', 1.0),
('sparpolitik', 'austerity', 1.0),
('austeridade', 'austerity', 1.0),
('kemer sıkma', 'austerity', 1.0),
('紧缩', 'austerity', 1.0),
('λιτότητα', 'austerity', 1.0),

-- default (economic)
('incumplimiento', 'default', 1.0),
('défaut de paiement', 'default', 1.0),
('تعثر', 'default', 1.0),
('дефолт', 'default', 1.0),
('zahlungsausfall', 'default', 1.0),
('inadimplência', 'default', 1.0),
('temerrüt', 'default', 1.0),
('违约', 'default', 1.0),
('채무불이행', 'default', 1.0),

-- ═══════════════════════════════════════════════════════════════
-- 6. HUMANITARIAN / SOCIAL
-- ═══════════════════════════════════════════════════════════════

-- displacement
('desplazamiento', 'displacement', 1.0),
('déplacement', 'displacement', 1.0),
('نزوح', 'displacement', 1.0),
('تهجير', 'displacement', 1.0),
('перемещение', 'displacement', 1.0),
('vertreibung', 'displacement', 1.0),
('deslocamento', 'displacement', 1.0),
('yerinden edilme', 'displacement', 1.0),
('流离失所', 'displacement', 1.0),

-- asylum
('asilo', 'asylum', 1.0),
('asile', 'asylum', 1.0),
('لجوء', 'asylum', 1.0),
('убежище', 'asylum', 1.0),
('asyl', 'asylum', 1.0),
('sığınma', 'asylum', 1.0),
('庇护', 'asylum', 1.0),
('망명', 'asylum', 1.0),
('शरण', 'asylum', 1.0),
('притулок', 'asylum', 1.0),

-- trafficking
('trata', 'trafficking', 1.0),
('traite', 'trafficking', 1.0),
('الاتجار', 'trafficking', 1.0),
('торговля людьми', 'trafficking', 1.0),
('menschenhandel', 'trafficking', 1.0),
('tráfico', 'trafficking', 1.0),
('insan ticareti', 'trafficking', 1.0),
('人口贩卖', 'trafficking', 1.0),
('人身売買', 'trafficking', 1.0),
('인신매매', 'trafficking', 1.0),

-- poverty
('pobreza', 'poverty', 1.0),
('pauvreté', 'poverty', 1.0),
('فقر', 'poverty', 1.0),
('бедность', 'poverty', 1.0),
('armut', 'poverty', 1.0),
('yoksulluk', 'poverty', 1.0),
('贫困', 'poverty', 1.0),
('貧困', 'poverty', 1.0),
('빈곤', 'poverty', 1.0),
('गरीबी', 'poverty', 1.0),
('povertà', 'poverty', 1.0),
('bieda', 'poverty', 1.0),
('бідність', 'poverty', 1.0),
('φτώχεια', 'poverty', 1.0),

-- epidemic
('epidemia', 'epidemic', 1.0),
('épidémie', 'epidemic', 1.0),
('وباء', 'epidemic', 1.0),
('эпидемия', 'epidemic', 1.0),
('epidemie', 'epidemic', 1.0),
('salgın', 'epidemic', 1.0),
('流行病', 'epidemic', 1.0),
('전염병', 'epidemic', 1.0),
('महामारी', 'epidemic', 1.0),

-- humanitarian aid
('ayuda humanitaria', 'humanitarian aid', 1.0),
('aide humanitaire', 'humanitarian aid', 1.0),
('مساعدات إنسانية', 'humanitarian aid', 1.0),
('гуманитарная помощь', 'humanitarian aid', 1.0),
('humanitäre hilfe', 'humanitarian aid', 1.0),
('ajuda humanitária', 'humanitarian aid', 1.0),
('insani yardım', 'humanitarian aid', 1.0),
('人道主义援助', 'humanitarian aid', 1.0),
('人道支援', 'humanitarian aid', 1.0),
('인도적지원', 'humanitarian aid', 1.0),

-- cholera
('cólera', 'cholera', 1.0),
('choléra', 'cholera', 1.0),
('كوليرا', 'cholera', 1.0),
('холера', 'cholera', 1.0),
('kolera', 'cholera', 1.0),
('霍乱', 'cholera', 1.0),
('콜레라', 'cholera', 1.0),

-- ═══════════════════════════════════════════════════════════════
-- 7. ENVIRONMENT / ENERGY
-- ═══════════════════════════════════════════════════════════════

-- emissions
('emisiones', 'emissions', 1.0),
('émissions', 'emissions', 1.0),
('انبعاثات', 'emissions', 1.0),
('выбросы', 'emissions', 1.0),
('emissionen', 'emissions', 1.0),
('emissões', 'emissions', 1.0),
('emisyon', 'emissions', 1.0),
('排放', 'emissions', 1.0),
('排出', 'emissions', 1.0),
('배출', 'emissions', 1.0),

-- deforestation
('deforestación', 'deforestation', 1.0),
('déforestation', 'deforestation', 1.0),
('إزالة الغابات', 'deforestation', 1.0),
('вырубка лесов', 'deforestation', 1.0),
('entwaldung', 'deforestation', 1.0),
('desmatamento', 'deforestation', 1.0),
('ormansızlaşma', 'deforestation', 1.0),
('森林砍伐', 'deforestation', 1.0),
('森林破壊', 'deforestation', 1.0),
('산림벌채', 'deforestation', 1.0),

-- renewable energy
('energía renovable', 'renewable energy', 1.0),
('énergie renouvelable', 'renewable energy', 1.0),
('طاقة متجددة', 'renewable energy', 1.0),
('возобновляемая энергия', 'renewable energy', 1.0),
('erneuerbare energie', 'renewable energy', 1.0),
('energia renovável', 'renewable energy', 1.0),
('yenilenebilir enerji', 'renewable energy', 1.0),
('可再生能源', 'renewable energy', 1.0),
('再生可能エネルギー', 'renewable energy', 1.0),
('재생에너지', 'renewable energy', 1.0),
('नवीकरणीय ऊर्जा', 'renewable energy', 1.0),

-- fossil fuel
('combustible fósil', 'fossil fuel', 1.0),
('combustible fossile', 'fossil fuel', 1.0),
('وقود أحفوري', 'fossil fuel', 1.0),
('ископаемое топливо', 'fossil fuel', 1.0),
('fossiler brennstoff', 'fossil fuel', 1.0),
('combustível fóssil', 'fossil fuel', 1.0),
('fosil yakıt', 'fossil fuel', 1.0),
('化石燃料', 'fossil fuel', 1.0),
('화석연료', 'fossil fuel', 1.0),

-- pollution
('contaminación', 'pollution', 1.0),
('pollution', 'pollution', 1.0),
('تلوث', 'pollution', 1.0),
('загрязнение', 'pollution', 1.0),
('verschmutzung', 'pollution', 1.0),
('poluição', 'pollution', 1.0),
('kirlilik', 'pollution', 1.0),
('污染', 'pollution', 1.0),
('汚染', 'pollution', 1.0),
('오염', 'pollution', 1.0),
('प्रदूषण', 'pollution', 1.0),
('inquinamento', 'pollution', 1.0),
('забруднення', 'pollution', 1.0),
('ρύπανση', 'pollution', 1.0),

-- carbon
('carbono', 'carbon', 1.0),
('carbone', 'carbon', 1.0),
('كربون', 'carbon', 1.0),
('углерод', 'carbon', 1.0),
('kohlenstoff', 'carbon', 1.0),
('karbon', 'carbon', 1.0),
('碳', 'carbon', 1.0),
('탄소', 'carbon', 1.0),

-- biodiversity
('biodiversidad', 'biodiversity', 1.0),
('biodiversité', 'biodiversity', 1.0),
('التنوع البيولوجي', 'biodiversity', 1.0),
('биоразнообразие', 'biodiversity', 1.0),
('biodiversität', 'biodiversity', 1.0),
('biodiversidade', 'biodiversity', 1.0),
('biyoçeşitlilik', 'biodiversity', 1.0),
('生物多样性', 'biodiversity', 1.0),
('生物多様性', 'biodiversity', 1.0),
('생물다양성', 'biodiversity', 1.0),

-- ═══════════════════════════════════════════════════════════════
-- 8. TECHNOLOGY / CYBER
-- ═══════════════════════════════════════════════════════════════

-- surveillance
('vigilancia', 'surveillance', 1.0),
('مراقبة', 'surveillance', 1.0),
('слежка', 'surveillance', 1.0),
('überwachung', 'surveillance', 1.0),
('vigilância', 'surveillance', 1.0),
('gözetleme', 'surveillance', 1.0),
('监控', 'surveillance', 1.0),
('監視', 'surveillance', 1.0),
('감시', 'surveillance', 1.0),
('निगरानी', 'surveillance', 1.0),

-- disinformation
('desinformación', 'disinformation', 1.0),
('désinformation', 'disinformation', 1.0),
('تضليل', 'disinformation', 1.0),
('дезинформация', 'disinformation', 1.0),
('desinformation', 'disinformation', 1.0),
('desinformação', 'disinformation', 1.0),
('dezenformasyon', 'disinformation', 1.0),
('虚假信息', 'disinformation', 1.0),
('偽情報', 'disinformation', 1.0),
('허위정보', 'disinformation', 1.0),
('дезінформація', 'disinformation', 1.0),

-- ransomware
('برنامج فدية', 'ransomware', 1.0),
('программа-вымогатель', 'ransomware', 1.0),
('勒索软件', 'ransomware', 1.0),
('ランサムウェア', 'ransomware', 1.0),
('랜섬웨어', 'ransomware', 1.0),

-- semiconductor
('semiconducteur', 'semiconductor', 1.0),
('أشباه الموصلات', 'semiconductor', 1.0),
('полупроводник', 'semiconductor', 1.0),
('halbleiter', 'semiconductor', 1.0),
('semicondutor', 'semiconductor', 1.0),
('yarı iletken', 'semiconductor', 1.0),
('半导体', 'semiconductor', 1.0),
('半導体', 'semiconductor', 1.0),
('반도체', 'semiconductor', 1.0),

-- censorship
('censura', 'censorship', 1.0),
('censure', 'censorship', 1.0),
('رقابة', 'censorship', 1.0),
('цензура', 'censorship', 1.0),
('zensur', 'censorship', 1.0),
('sansür', 'censorship', 1.0),
('审查', 'censorship', 1.0),
('検閲', 'censorship', 1.0),
('검열', 'censorship', 1.0),

-- espionage
('espionaje', 'espionage', 1.0),
('espionnage', 'espionage', 1.0),
('تجسس', 'espionage', 1.0),
('шпионаж', 'espionage', 1.0),
('spionage', 'espionage', 1.0),
('espionagem', 'espionage', 1.0),
('casusluk', 'espionage', 1.0),
('间谍', 'espionage', 1.0),
('スパイ活動', 'espionage', 1.0),
('간첩', 'espionage', 1.0),

-- ═══════════════════════════════════════════════════════════════
-- 9. POLITICAL
-- ═══════════════════════════════════════════════════════════════

-- referendum
('referéndum', 'referendum', 1.0),
('référendum', 'referendum', 1.0),
('استفتاء', 'referendum', 1.0),
('референдум', 'referendum', 1.0),
('volksabstimmung', 'referendum', 1.0),
('referendo', 'referendum', 1.0),
('公投', 'referendum', 1.0),
('国民投票', 'referendum', 1.0),
('국민투표', 'referendum', 1.0),
('जनमत संग्रह', 'referendum', 1.0),

-- impeachment
('destitución', 'impeachment', 1.0),
('impugnación', 'impeachment', 1.0),
('عزل', 'impeachment', 1.0),
('импичмент', 'impeachment', 1.0),
('amtsenthebung', 'impeachment', 1.0),
('impeachment', 'impeachment', 1.0),
('弹劾', 'impeachment', 1.0),
('탄핵', 'impeachment', 1.0),
('महाभियोग', 'impeachment', 1.0),

-- junta
('junta militar', 'junta', 1.0),
('junte militaire', 'junta', 1.0),
('المجلس العسكري', 'junta', 1.0),
('хунта', 'junta', 1.0),
('militärjunta', 'junta', 1.0),
('askeri cunta', 'junta', 1.0),
('军政府', 'junta', 1.0),
('군사정권', 'junta', 1.0),

-- martial law
('ley marcial', 'martial law', 1.0),
('loi martiale', 'martial law', 1.0),
('الأحكام العرفية', 'martial law', 1.0),
('военное положение', 'martial law', 1.0),
('kriegsrecht', 'martial law', 1.0),
('lei marcial', 'martial law', 1.0),
('sıkıyönetim', 'martial law', 1.0),
('戒严', 'martial law', 1.0),
('戒厳令', 'martial law', 1.0),
('계엄령', 'martial law', 1.0),

-- propaganda
('пропаганда', 'propaganda', 1.0),
('دعاية', 'propaganda', 1.0),
('宣传', 'propaganda', 1.0),
('プロパガンダ', 'propaganda', 1.0),
('선전', 'propaganda', 1.0),
('प्रचार', 'propaganda', 1.0),

-- annexation
('anexión', 'annexation', 1.0),
('annexion', 'annexation', 1.0),
('ضم', 'annexation', 1.0),
('аннексия', 'annexation', 1.0),
('anexação', 'annexation', 1.0),
('ilhak', 'annexation', 1.0),
('吞并', 'annexation', 1.0),
('併合', 'annexation', 1.0),
('합병', 'annexation', 1.0),
('анексія', 'annexation', 1.0),
('προσάρτηση', 'annexation', 1.0),

-- ═══════════════════════════════════════════════════════════════
-- 10. HEALTH
-- ═══════════════════════════════════════════════════════════════

-- vaccine
('vacuna', 'vaccine', 1.0),
('vaccin', 'vaccine', 1.0),
('لقاح', 'vaccine', 1.0),
('вакцина', 'vaccine', 1.0),
('impfstoff', 'vaccine', 1.0),
('vacina', 'vaccine', 1.0),
('aşı', 'vaccine', 1.0),
('疫苗', 'vaccine', 1.0),
('ワクチン', 'vaccine', 1.0),
('백신', 'vaccine', 1.0),
('टीका', 'vaccine', 1.0),
('vaccino', 'vaccine', 1.0),
('szczepionka', 'vaccine', 1.0),
('εμβόλιο', 'vaccine', 1.0),

-- outbreak
('brote', 'outbreak', 1.0),
('éclosion', 'outbreak', 1.0),
('تفشي', 'outbreak', 1.0),
('вспышка', 'outbreak', 1.0),
('ausbruch', 'outbreak', 1.0),
('surto', 'outbreak', 1.0),
('爆发', 'outbreak', 1.0),
('アウトブレイク', 'outbreak', 1.0),
('발생', 'outbreak', 1.0),

-- quarantine
('cuarentena', 'quarantine', 1.0),
('quarantaine', 'quarantine', 1.0),
('حجر صحي', 'quarantine', 1.0),
('карантин', 'quarantine', 1.0),
('quarantäne', 'quarantine', 1.0),
('quarentena', 'quarantine', 1.0),
('karantina', 'quarantine', 1.0),
('隔离', 'quarantine', 1.0),
('検疫', 'quarantine', 1.0),
('격리', 'quarantine', 1.0)

ON CONFLICT (original_keyword) DO UPDATE SET
  normalized_keyword = EXCLUDED.normalized_keyword,
  confidence = EXCLUDED.confidence;

-- Also backfill the article_keywords.normalized_keyword column for any
-- articles that already have these foreign-language keywords extracted.
-- This runs as a single UPDATE joining the translations table.
UPDATE article_keywords ak
SET normalized_keyword = kt.normalized_keyword
FROM keyword_translations kt
WHERE LOWER(ak.keyword) = kt.original_keyword
  AND ak.normalized_keyword IS NULL;
