# LazyLord — লাইভ টেস্ট চেকলিস্ট (v0.8)

এই সংস্করণের সব কোড শুধু নকল (mock) Adobe/Figma পরিবেশে টেস্ট করা হয়েছে। আসল অ্যাপে প্রথমবার চালিয়ে দেখার জন্য এই তালিকা।
**⚠ চিহ্ন দেওয়া ঘরগুলো সবচেয়ে জরুরি।** এগুলো ডকুমেন্টেশন দেখে লেখা অনুমান, আসল অ্যাপ ছাড়া নিশ্চিত হওয়ার উপায় নেই।

## ০. সেটআপ

- [ ] `install.bat` ডাবল-ক্লিক করুন। শেষে "Installed." লেখা আসে কিনা দেখুন। কোনো `[warn]` বা `[!]` এলে সেই লেখাটা কপি করে রাখুন। **আর কোনো bridge উইন্ডো খোলার কথা নয়।**
- [ ] Photoshop, Illustrator আর After Effects রিস্টার্ট করুন। প্রতিটায় **Window → Extensions (legacy) → LazyLord** খোলে, আর উপরের ডটটা নিজে থেকেই সবুজ হয়। bridge এখন প্যানেলের ভেতরেই চলে।
- [ ] ⚠ **বিল্ট-ইন bridge:** শুধু একটা Adobe অ্যাপে প্যানেল খোলা রেখে Figma প্লাগিন খুলুন। "Connected" দেখানোর কথা।
- [ ] ⚠ **হাতবদল:** দুটো Adobe অ্যাপে প্যানেল খোলা রাখুন। যে অ্যাপটা আগে খুলেছিলেন সেটা বন্ধ করুন। কয়েক সেকেন্ডের মধ্যে অন্য অ্যাপের প্যানেল আর Figma আবার সবুজ বা "Connected" হওয়ার কথা।
- [ ] Figma **desktop** অ্যাপে: Plugins → Development → Import plugin from manifest…, তারপর `packages\figma-plugin\manifest.json` বেছে নিন। প্লাগিন খুললে "Connected" দেখায়, আর চালু থাকা Adobe অ্যাপগুলোর তালিকা দেখায়।
- [ ] যে অ্যাপে প্যানেল খোলা নেই, সেখানে পাঠালে পরিষ্কার একটা error মেসেজ আসে।

## ১. Figma → After Effects

সব টেস্টের আগে AE-তে কোনো comp খোলা রাখবেন না (নতুন comp তৈরির টেস্ট) — তারপর আবার একটা comp খোলা রেখে চালান।

- [ ] সাধারণ vector shape: আকার, রং, stroke-এর মোটা/cap/join ঠিক আছে।
- [ ] Rectangle আর Ellipse: shape layer-এর ভেতরে live **Rectangle / Ellipse** আসে (Path নয়), corner radius ঠিক থাকে।
- [ ] ⚠ **Linear gradient:** একটা বাঁকা (diagonal) gradient দেওয়া লম্বা আয়তক্ষেত্র পাঠান। layer-এ **Gradient Ramp** effect থাকে, আর রং আর দিক Figma-র মতোই দেখায়। দিক বা জায়গা সরে গেলে স্ক্রিনশট নিন — এটাই সবচেয়ে বড় অনিশ্চয়তা।
- [ ] ⚠ **Radial gradient:** মাঝখান আর ব্যাসার্ধ Figma-র মতো।
- [ ] Gradient-এর সঙ্গে stroke থাকলে stroke আলাদা "… stroke" layer হয়ে ঠিক উপরে বসে।
- [ ] তিনটার বেশি রঙের gradient: প্যানেলে "approximated" সতর্কতা আসে।
- [ ] **Clip content** চালু থাকা frame-এর ভেতরের জিনিস AE-তে **mask** দিয়ে কাটা থাকে।
- [ ] Figma-র mask (isMask) দিয়ে ঢাকা জিনিসও mask হয়ে আসে।
- [ ] ⚠ **ঘোরানো** rectangle, text আর image ঠিক জায়গায় আর ঠিক কোণে বসে (আগে উপরের-বাঁ কোণ ঘিরে ঘুরে সরে যেত)।
- [ ] মাঝখানে (center) আর ডানে (right) সাজানো text-এর অবস্থান ঠিক।
- [ ] মিশ্র স্টাইলের text outline হয়ে আসে, আর প্যানেলে সতর্কতা দেখায়।
- [ ] Image scale 1x আর 4x দুটো দিয়ে পাঠান: 4x-এর ছবি বেশি ধারালো।
- [ ] Background রং দেওয়া frame-এর background আলাদা shape হয়ে আসে।
- [ ] একটা বড় frame-এর (যেমন 1920×1080) ভেতরের ছোট icon পাঠান, কোনো comp খোলা না রেখে: নতুন comp **frame-এর মাপে** তৈরি হয়, আর icon frame-এ যেখানে ছিল সেখানেই বসে।
- [ ] যা native হয়নি, প্যানেলের তালিকায় তার নাম আর কারণ দেখায়।

## ২. Figma → Illustrator

- [ ] ⚠ **Gradient:** আসল Illustrator gradient আসে (Gradient panel-এ এডিট করা যায়), আর দিক ও দৈর্ঘ্য Figma-র মতো। বাঁকা gradient আলাদাভাবে পরীক্ষা করুন।
- [ ] Clip content frame → **Clipping group**।
- [ ] ঘোরানো text আর image ঠিক কোণে ও জায়গায়।
- [ ] মাঝখানে আর ডানে সাজানো text ঠিক জায়গায়। (এর একটা fix শেষ হওয়ার পথে — এটা ভুল দেখালে জানাবেন।)
- [ ] ছবি **embed** হয়ে থাকে (Links panel-এ temp ফাইলের link নয়)।
- [ ] নতুন document artboard বা frame-এর মাপে তৈরি হয়।

## ৩. Figma → Photoshop

- [ ] ⚠ Vector এখন **এডিটযোগ্য shape layer** (Direct Selection দিয়ে point টানা যায়), রাস্টার নয়। না হলে প্যানেলে "approximated" সতর্কতা আসার কথা — কী লেখা আছে কপি করুন।
- [ ] ⚠ **Gradient:** **Gradient Fill layer** হয়, আর angle ও scale Figma-র মতো। খুব লম্বা-সরু shape-এ ১৫০% সীমার সতর্কতা আসতে পারে — এটা প্রত্যাশিত।
- [ ] Stroke-এর রং আর মোটা ঠিক।
- [ ] ⚠ Clip content frame → vector mask দেওয়া **layer group**।
- [ ] ঘোরানো text আর image ঠিক।
- [ ] কোনো document খোলা না থাকলে নতুন document ঠিক মাপে তৈরি হয়।

## ৪. Illustrator → After Effects

- [ ] সাধারণ path, আর compound path-এ ছিদ্র (hole) ঠিক থাকে।
- [ ] আয়তক্ষেত্র আর উপবৃত্ত AE-তে live Rect / Ellipse হয়।
- [ ] **Clipping group** → AE-তে mask।
- [ ] ⚠ **Gradient:** gradient দেওয়ার **পরে** বস্তুটা ঘুরিয়ে বা বড়-ছোট করে তারপর পাঠান: দিক ঠিক থাকে।
- [ ] Point text নিজের আসল baseline-এ বসে।
- [ ] ⚠ **ঘোরানো point text** আর **ঘোরানো placed image** ঠিক কোণে আসে (আগে সোজা হয়ে বা চ্যাপ্টা হয়ে আসত)।
- [ ] Linked image AE-তে **আপনার আসল ফাইল** হিসেবে আসে।
- [ ] Mesh, symbol বা effect দেওয়া জিনিস PNG হয়ে আসে, আর প্যানেলে সতর্কতা দেখায়।
- [ ] **স্তরের ক্রম:** Illustrator-এ সামনের জিনিস AE-তেও উপরে থাকে (আগে উল্টো হতো)।
- [ ] CMYK আর Spot রং মোটামুটি একই দেখায়।
- [ ] Artboard-এ যেখানে ছিল, AE-তে সেখানেই বসে। নতুন comp **artboard-এর মাপে** হয়।
- [ ] **Asset folder:** AE project আগে save করা থাকলে তৈরি হওয়া ছবি `.aep`-এর পাশে `LazyLord Assets` ফোল্ডারে যায়। Save না থাকলে "Project" নামে একটা সতর্কতা আসে।

## ৫. After Effects → Illustrator

- [ ] ⚠ একই shape layer-এ **লাল বৃত্ত আর নীল বর্গ** (দুটো আলাদা group, আলাদা fill): Illustrator-এ দুটো আলাদা রঙেই আসে।
- [ ] Rect, Ellipse আর Star shape ঠিক আকারে আসে।
- [ ] ⚠ **Parent করা layer** (একটা null-এর child, null ঘোরানো বা সরানো): Illustrator-এ AE-র মতোই জায়গায় বসে।
- [ ] Parent null আর তার child একসঙ্গে select করে Hierarchy "Groups" দিয়ে পাঠালে Illustrator-এ group হয়।
- [ ] **Add mask** → clipping group। Subtract mask দিলে প্যানেলে সতর্কতা আসে।
- [ ] **Gradient round trip:** Illustrator → AE → Illustrator করলে gradient ফিরে আসে।
- [ ] দুটো ওভারল্যাপ করা ellipse (Non-Zero fill rule) ফেরত আসার পর মাঝখানে ফাঁকা ছিদ্র হয় না।
- [ ] ঘোরানো text আর ঘোরানো footage ঠিক কোণে আসে। Footage আসল ফাইল হিসেবে আসে।
- [ ] Solid layer রঙিন আয়তক্ষেত্র হয়ে আসে।
- [ ] Track matte দেওয়া layer-এ প্যানেলে সতর্কতা আসে।

## ৫ক. Destination (Figma প্লাগিনে)

প্রতিটা অ্যাপে (PS, AI, AE) একটা document বা comp **খোলা রেখে** পরীক্ষা করুন।

- [ ] **ডিফল্ট (frame or object size) + পুরো frame বা section select করে পাঠান:** নতুন document বা comp তৈরি হয়, frame-এর মাপে আর frame-এর নামে। AE-তে নতুন comp নিজে থেকে খুলে যায়।
- [ ] **ডিফল্ট + frame-এর ভেতরের একটা object পাঠান:** নতুন document তৈরি হয়, শুধু সেই object-এর মাপে আর নামে।
- [ ] **New document — top-level frame size + frame-এর ভেতরের object:** নতুন document তৈরি হয় frame-এর মাপে, আর object frame-এ যেখানে ছিল সেখানে বসে।
- [ ] **Open document:** খোলা document বা comp-এই বসে, নতুন কিছু তৈরি হয় না।
- [ ] **একাধিক frame একসঙ্গে select করে (নতুন document বাছা থাকলে):** প্রতিটা frame-এর জন্য **আলাদা** comp বা document তৈরি হয়, প্রতিটার নাম আর মাপ নিজ নিজ frame অনুযায়ী। Figma-য় "N of N frames built as separate comps" দেখায়।
- [ ] **background ছাড়া frame:** comp frame-এর পুরো মাপেই হয়, ভেতরের জিনিসের মাপে নয়, আর জিনিসগুলো frame-এ যেখানে ছিল সেখানেই বসে।
- [ ] **একাধিক frame + Open document:** সব একসঙ্গে খোলা document-এ যায়।
- [ ] Figma প্লাগিন বন্ধ করে আবার খুললে বাছাই করা Destination মনে থাকে।
- [ ] Illustrator থেকে পাঠানো আর AE থেকে পাঠানো আগের মতোই খোলা document বা comp-এ যায়।

## ৬. Options (Layout / Hierarchy)

প্যানেলের Send card বা Figma প্লাগিনে **Options** খুলে বাছুন।

- [ ] **Hierarchy = Groups → AE:** প্রতিটা group-এর জন্য একটা **null**, আর layer গুলো তার child।
- [ ] ⚠ Null-এ parent করার পরও layer গুলো **সরে যায় না** (AE-তে parent সেট করার আসল আচরণ এখানে পরীক্ষা হচ্ছে)।
- [ ] **Hierarchy = Groups → Illustrator / Photoshop:** group বা layer group, নাম আর opacity সহ।
- [ ] **Layout = Combine → AE:** সব shape **একটা shape layer**-এ, প্রতিটা আলাদা vector group-এ, আর ক্রম ঠিক থাকে। Text, ছবি আর gradient shape আলাদা layer-এ থাকে, আর তা নিয়ে একটা সতর্কতা আসে।
- [ ] Combine + Groups → AE: Figma-র group গুলো shape layer-এর ভেতরে nested group হয়।
- [ ] অ্যাপ বন্ধ করে আবার খুললে বাছাই করা অপশন মনে থাকে।
- [ ] ডিফল্টে (Split + Flatten) ফল আগের সংস্করণের মতোই।

## ৬ক. Shape updating (Existing / Keyframes) — নতুন

পুরো Phase 3-টা host API-র দুটো অনুমানের উপর দাঁড়িয়ে: AE-র layer **comment** আর Illustrator-এর item **note** সেভ করার পরও টিকে থাকে। **প্রথমে সেটাই যাচাই করুন।**

- [ ] ⚠ **ট্যাগ টেকে কিনা:** Add দিয়ে একবার পাঠান। AE-তে layer-এর **Comment** কলামে (Timeline-এ ডান-ক্লিক → Columns → Comment) `[[LazyLord …]]` দেখা যায়; Illustrator-এ item সিলেক্ট করে **Window → Attributes**-এর Note-এ একই জিনিস। প্রোজেক্ট/ফাইল **সেভ করে বন্ধ করে আবার খুলুন** — ট্যাগ এখনও আছে কিনা দেখুন।
- [ ] **প্রথমবার সবসময় Add:** Existing = Update দিয়ে একেবারে নতুন কিছু পাঠালে সেটা যোগই হয়, আর প্যানেল বলে "Nothing matched…"।
- [ ] **দ্বিতীয়বার আপডেট হয়:** Figma/Illustrator-এ shape-টার রং আর অবস্থান বদলে Existing = **Update** দিয়ে আবার পাঠান — **নতুন layer তৈরি হয় না**, পুরোনোটাই বদলায়। সারসংক্ষেপে "N layers updated" আসে।
- [ ] **জায়গা ঠিক থাকে:** আপডেট হওয়া layer stack-এ নিজের জায়গাতেই থাকে (উপরে উঠে আসে না), তার parent/effect/mask ঠিক থাকে।
- [ ] ⚠ **Keyframes = Auto:** AE-তে ওই layer-এর Position-এ আগে থেকে একটা keyframe দিন। playhead সরিয়ে Update পাঠান — **playhead-এর জায়গায় নতুন key** বসে, পুরোনো key মুছে যায় না। যে property-তে keyframe ছিল না সেটা keyframe ছাড়াই থাকে।
- [ ] ⚠ **Keyframes = Always:** playhead সরিয়ে দু-তিনবার Update পাঠান — প্রতিবার সব property-তে key বসে, অর্থাৎ shape-টা animate হয়।
- [ ] **অন্য ফাইল মেলে না:** একই নামের অন্য একটা Figma ফাইল/Illustrator ডকুমেন্ট থেকে Update পাঠালে সেটা **যোগ** হয়, পুরোনোটা বদলায় না।
- [ ] **Update + Groups/Combine:** বাছলে প্যানেল বলে যে ওগুলো উপেক্ষা করা হয়েছে, আর কোনো null/group তৈরি হয় না।
- [ ] **Figma-তে Destination উপেক্ষা:** Existing = Update বাছলে প্লাগিন লিখে দেয় যে খোলা ডকুমেন্টেই যাবে।
- [ ] **হাতে বদলানো shape:** AE-তে shape layer-এর ভেতরে একটা বাড়তি path যোগ করে Update পাঠান — কিছু **মুছে যায় না**, আর "only the ones that pair up" জাতীয় সতর্কতা আসে।
- [ ] ⚠ **Illustrator-এ replace:** Update-এ পুরোনো item সরে গিয়ে নতুনটা **ঠিক সেই জায়গায়** বসে (সামনে চলে আসে না), আর ডুপ্লিকেট পড়ে থাকে না।
- [ ] **ট্যাগ মুছে দিলে:** কোনো layer-এর comment/note থেকে `[[LazyLord …]]` অংশটা মুছে Update পাঠান — ওটা নতুন layer হিসেবে যোগ হয়।
- [ ] আপনার নিজের লেখা comment/note থাকলে সেটা **নষ্ট হয় না**, ট্যাগ শুধু আলাদা লাইনে বসে।

## ৬খ. সব দিকে আনা-নেয়া (v0.6) — নতুন

এখন চারটে অ্যাপই পাঠাতে আর নিতে পারে। প্যানেলের বোতামে আর "Push"/"Pull" লেখা নেই — **কোথায় যাচ্ছে সেটাই লেখা** ("Send to After Effects")।

- [ ] **Photoshop থেকে পাঠানো:** PS-এ shape layer, text layer আর একটা pixel layer সিলেক্ট করে AE-তে পাঠান। Shape এডিটযোগ্য path হয়, text live text হয়, pixel layer ছবি হয়ে আসে।
- [ ] ⚠ **PS-এ একাধিক layer সিলেক্ট:** তিনটে layer একসাথে সিলেক্ট করে পাঠালে তিনটেই যায়। যদি শুধু একটা যায় আর "Only the active layer could be read" সতর্কতা আসে — সেটা কপি করে জানাবেন।
- [ ] ⚠ **PS shape layer:** Illustrator-এ পাঠিয়ে দেখুন path-টা **এডিটযোগ্য** কিনা (ছবি নয়)। না হলে প্যানেল কী কারণ দেখাচ্ছে জানাবেন।
- [ ] **Adobe → Figma:** Illustrator বা AE থেকে **Send to Figma** করুন (Figma প্লাগিন খোলা থাকতে হবে)। Figma-তে vector, text আর ছবি এসে বসে, আর যা এলো তা-ই সিলেক্ট হয়ে থাকে।
- [ ] ⚠ **Figma-তে ছবি:** linked ছবি সহ কিছু পাঠান — Figma-তে ছবিটা আসে (path নয়, আসল ছবি)।
- [ ] **সব দিক:** PS→AI, AI→PS, AE→PS, PS→Figma — প্রতিটা অন্তত একবার।

## ৬গ. প্যানেলে Destination আর Image scale — নতুন

আগে এগুলো শুধু Figma প্লাগিনে ছিল; এখন Adobe প্যানেলেও আছে।

- [ ] **Destination = Open document** (ডিফল্ট): খোলা document/comp-এ বসে, আগের মতোই।
- [ ] ⚠ **Destination = New — source page size:** AE থেকে Illustrator-এ পাঠালে **comp-এর মাপে নতুন document** তৈরি হয়, আর আর্টওয়ার্ক comp-এ যেখানে ছিল সেখানেই বসে। (এটাই আপনার চাওয়া জিনিসটা।)
- [ ] **Destination = New — selection size:** শুধু সিলেকশনের মাপে নতুন document, আর্টওয়ার্ক তার origin-এ।
- [ ] **Image scale:** 1x আর 4x দিয়ে এমন কিছু পাঠান যা raster হয় (mesh, symbol, PS pixel layer) — 4x-এর ছবি স্পষ্ট বেশি ধারালো।
- [ ] অ্যাপ বন্ধ করে খুললে Destination আর scale মনে থাকে।

## ৬ঘ. Blend mode আর Effects — নতুন

- [ ] **Blend mode:** Figma-তে একটা shape-এ **Multiply** দিয়ে AE-তে পাঠান — AE-তেও Multiply থাকে। Illustrator আর Photoshop-এও পরীক্ষা করুন।
- [ ] ⚠ **Drop shadow → AE:** Figma-তে drop shadow (offset নিচে-ডানে, blur আছে) দিয়ে AE-তে পাঠান। AE-তে **Drop Shadow** effect বসে, আর ছায়াটা **একই দিকে** পড়ে। দিক উল্টো হলে স্ক্রিনশট নিন — direction-এর হিসাবটা এখানেই যাচাই হচ্ছে।
- [ ] ⚠ **Layer blur → AE:** blur দেওয়া shape পাঠান — AE-তে Gaussian Blur বসে, আর ঝাপসার মাত্রা কাছাকাছি দেখায়।
- [ ] **Spread:** shadow-এ spread দিলে AE-তে effect বসে ঠিকই, কিন্তু "spread" নিয়ে একটা সতর্কতা আসে — এটা প্রত্যাশিত।
- [ ] **Inner shadow / background blur:** এগুলো দিয়ে পাঠালে AE-তে কিছু বসে **না**, আর কারণ সহ সতর্কতা আসে — এটাও প্রত্যাশিত।
- [ ] **Illustrator / Photoshop-এ effect:** shadow দেওয়া কিছু পাঠালে effect বসে না, কিন্তু "left off" সতর্কতা আসে।
- [ ] ⚠ **ছায়া দুবার পড়ে না:** Figma-তে shadow দেওয়া এমন একটা জিনিস পাঠান যেটা ছবি হয়ে যায় (যেমন image fill সহ frame) — ছায়াটা **একবারই** দেখা যায়, দুবার নয়।

## ৬ঙ. ইন্টারফেস আর রিসাইজ (v0.7) — নতুন

Figma প্লাগিন আর Adobe প্যানেল এখন **একই স্টাইলশিট** পরে (`packages/ui-kit/lazylord.css`)।

- [ ] **প্যানেলের চেহারা:** PS/AI/AE-র প্যানেল এখন Figma প্লাগিনের মতো দেখায় — উপরে বড় অক্ষরে SEND TO / IMAGE SCALE / DESTINATION / OPTIONS, আর টার্গেট বাছাই dropdown নয়, **বোতাম** (chip)।
- [ ] **বোতামে গন্তব্যের নাম:** টার্গেট বদলালে নিচের বড় বোতামের লেখাও বদলায় — "Send to After Effects" → "Send to Photoshop"।
- [ ] ⚠ **Figma প্লাগিন টেনে বড় করা:** প্লাগিনের **নিচ-ডান কোণে** একটা ছোট তির্যক দাগ আছে — সেটা মাউস দিয়ে টেনে জানালা বড়-ছোট করুন। আগে ৩২০×৫৪০-এ আটকানো ছিল।
- [ ] **মাপ মনে থাকে:** প্লাগিন বন্ধ করে আবার খুললে আপনার করা মাপেই খোলে।
- [ ] **সবচেয়ে ছোট মাপ:** টেনে খুব ছোট করার চেষ্টা করুন — ৩০০×৩৬০-এর নিচে যায় না, আর ভেতরের জিনিস উপচে পড়ে না।
> ⚠ **প্যানেলের মাপ বদলানোর আগে Photoshop/Illustrator/After Effects পুরোপুরি বন্ধ করে আবার চালু করুন।** CEP শুধু অ্যাপ চালু হওয়ার সময় manifest পড়ে, আর প্যানেল বড় করার অনুমতি ওখানেই লেখা (`MaxSize`)। `install.bat` junction ব্যবহার করে, তাই নতুন করে ইনস্টল করার দরকার নেই — শুধু রিস্টার্ট। (যদি `install-cep.ps1` দিয়ে ইনস্টল করে থাকেন আর সেটা copy করে থাকে, তাহলে ওটা আবার চালাতে হবে।)

- [ ] ⚠ **প্যানেল বড় করা:** Adobe-র প্যানেলের কিনারা টেনে বড় করুন — **আগে এটা কাজ করত না**, ৩০০×৩৬০-এ আটকে থাকত। এখন যত খুশি বড় হওয়ার কথা।
- [ ] **প্যানেল সরু করা:** কিনারা টেনে সরু করুন (২৪০px পর্যন্ত) — বোতামগুলো এক কলামে নেমে আসে, **পাশে স্ক্রলবার আসে না**।
- [ ] **প্যানেল চওড়া করা:** চওড়া করলে বোতামগুলো ২, ৩, ৪ কলামে ছড়ায় — কিন্তু হাস্যকরভাবে পুরো পর্দা জুড়ে টানটান হয়ে যায় না।
- [ ] প্যানেলের log আর fallback তালিকা আগের মতোই কাজ করে।

## ৭. প্যানেল

- [ ] **Auto-receive** বন্ধ রেখে অন্য অ্যাপ থেকে পাঠান: পাঠানো অ্যাপে "auto-receive is off" জাতীয় বার্তা আসে, ২০ সেকেন্ড আটকে থাকে না।
- [ ] প্রতিটা ট্রান্সফারের পর এক লাইনের সারসংক্ষেপ আসে: কয়টা layer, কয়টা image (আসল বনাম তৈরি করা), আর কয়টা fallback।
- [ ] যা native হয়নি তার তালিকা skipped → rasterized → approximated ক্রমে সাজানো থাকে।

---

## ধাপ ১: নির্ভরযোগ্যতা, history আর preset

- [ ] **History:** কয়েকটা ট্রান্সফার পাঠান আর নিন। প্যানেলের (আর Figma-র) **History** খুললে সময়, কোথা থেকে বা কোথায়, নাম, layer সংখ্যা আর fallback দেখায়। ব্যর্থ হওয়াটা লাল রঙে দেখায়। প্যানেল বন্ধ করে আবার খুললেও থাকে। **Clear history** দিলে মুছে যায়।
- [ ] **Preset:** Options খুলে কিছু বদলান, নাম লিখে **Save** দিন। তারপর সেটিং বদলে আবার preset বেছে নিলে সব ফিরে আসে। **Delete** দিলে মুছে যায়।
- [ ] **বড় ট্রান্সফার:** অনেক বড় ছবিসহ ট্রান্সফার (৪ MB-র বেশি) পাঠালে প্যানেলের log-এ "sent in N pieces" দেখায়, আর গন্তব্যে ঠিকঠাক তৈরি হয়।
- [ ] **পুরোনো temp ফাইল:** `%TEMP%\lazylord`-এ ৭ দিনের পুরোনো ফোল্ডার থাকলে প্যানেল খোলার সময় সেগুলো মুছে log-এ জানায়।
- [ ] ⚠ **Rollback:** এটা ইচ্ছে করে ঘটানো কঠিন। কোনো ট্রান্সফার মাঝপথে error দিলে বার্তার শেষে "Everything this transfer had built was removed again" দেখায় কিনা, আর আপনার আগের layer অক্ষত থাকে কিনা, খেয়াল রাখুন।

## ধাপ ২: Pro ফিচার

- [ ] ⚠ **এক লেখায় কয়েক রকম স্টাইল (text runs):** Figma-তে একটা text-এর একটা শব্দ বোল্ড, অন্য রং আর বড় সাইজ করে AE, Illustrator আর Photoshop-এ পাঠান। তিন জায়গাতেই লেখাটা **live text** থাকে, আর ওই শব্দের স্টাইল আলাদা থাকে। AE-তে এর জন্য **After Effects 24.3 বা নতুন** লাগবে; পুরোনো AE-তে প্রথম অক্ষরের স্টাইল পুরো লেখায় বসে, আর তা নিয়ে সতর্কতা আসে।
- [ ] **উল্টো দিকে:** Illustrator-এ মিশ্র স্টাইলের text Figma বা AE-তে পাঠান। স্টাইলগুলো ঠিক থাকে কিনা দেখুন।
- [ ] **Hierarchy = Precomps (AE):** Figma-তে frame-এর ভেতরে frame আছে এমন ডিজাইন AE-তে পাঠান। প্রতিটা frame **নিজের মাপের precomp** হয়, ভেতরের frame তার ভেতরে nested precomp হয়, আর সব আগের জায়গাতেই দেখায়। Illustrator বা Photoshop-এ পাঠালে এটা Groups-এর মতো কাজ করে।
- [ ] **Precompose / Decompose (AE প্যানেল):** AE-তে কয়েকটা layer সিলেক্ট করে **Precompose selected** দিন। সেগুলো একটা precomp-এ চলে যায়, আর দেখতে কিছু বদলায় না। তারপর precomp layer-টা সিলেক্ট করে **Decompose precomp** দিন। layer-গুলো আগের জায়গায় comp-এ ফিরে আসে, আর precomp layer-টা সরে যায়।
- [ ] **Include guides:** Figma-র frame-এ ruler guide টেনে Options-এ **Include guides** দিয়ে পাঠান। AE (16.1+), Illustrator আর Photoshop-এ একই জায়গায় guide দেখা যায়। Illustrator-এ guide-গুলো লম্বা guide path হিসেবে আসে।
- [ ] **Include swatches:** Figma-তে কয়েকটা color style রেখে **Include swatches** দিয়ে পাঠান। Illustrator-এর Swatches প্যানেলে একই নামে রং যোগ হয়। AE-তে **"Swatches"** নামে একটা guide layer আসে, যেখানে প্রতিটা রঙের একটা করে বর্গ থাকে; এটা রেন্ডারে আসে না। Photoshop-এ swatch যোগ হয় না, শুধু সতর্কতা আসে। একই নামের swatch আগে থেকে থাকলে সেটা দ্বিতীয়বার যোগ হয় না।
- [ ] ⚠ **Import PSD from Photoshop (AE প্যানেল):** Photoshop-এ একটা PSD খুলে **সেভ করুন**। তারপর AE প্যানেলে **Import PSD from Photoshop** দিন। Photoshop-এর ফাইলটা layer-সহ composition হিসেবে AE-তে আসে। Photoshop চালু না থাকলে ফাইল বেছে নেওয়ার ডায়ালগ আসে। সেভ না করা বদল আসবে না, কারণ AE ফাইলের সেভ করা সংস্করণটাই পড়ে।

## ধাপ ৩: Smart diff, conflict আর Live sync — নতুন

এই তিনটেই **Existing = Update** নিয়ে কাজ করে। তাই প্রথমে একবার Add (বা Update) দিয়ে পাঠিয়ে গন্তব্যে layer তৈরি করে নিন।

**Smart diff: শুধু বদলানো জিনিস যায়**

- [ ] Existing = Update বাছলে Options-এ **"Only what changed"** চেকবক্স দেখা যায়, আর সেটা ডিফল্টে টিক দেওয়া থাকে।
- [ ] কিছু না বদলে আবার Update পাঠান। কিছুই যায় না, আর "Nothing changed since the last send" লেখা আসে।
- [ ] দশটা জিনিসের একটা সরিয়ে Update পাঠান। log/status-এ দেখায় "9 unchanged layers not sent again", আর গন্তব্যে শুধু ওইটাই বদলায়।
- [ ] গন্তব্যে কোনো layer মুছে ফেললে Update সেটা আবার আনবে না, কারণ LazyLord জানে ওটা আগে পাঠানো হয়ে গেছে। তখন **"Only what changed"-এর টিক তুলে** পাঠান, সব আবার যাবে।
- [ ] Figma প্লাগিন বন্ধ করে আবার খুললে প্রথম Update-এ সব একবার যায়। এটা প্রত্যাশিত; Adobe প্যানেল আগের পাঠানোর হিসাব মনে রাখে।

**Conflict: গন্তব্যে হাতে করা বদল ধরা**

- [ ] Existing = Update বাছলে Options-এ **"On conflict"** আসে: **Overwrite** (ডিফল্ট) আর **Keep my edits**।
- [ ] ⚠ **AE, Overwrite:** Figma থেকে একটা shape AE-তে পাঠান। AE-তে সেটা হাতে সরান বা রং বদলান। এবার Figma-তে ওই shape-টা বদলে Update পাঠান। Figma-র বদলটা বসে যায়, আর সতর্কতার তালিকায় লেখা আসে "Was changed in After Effects since it was last sent; the update replaced those changes"।
- [ ] ⚠ **AE, Keep my edits:** একই কাজ করুন, কিন্তু On conflict = **Keep my edits** রাখুন। AE-তে আপনার হাতের বদলটাই থাকে, layer ছোঁয়া হয় না, আর লেখা আসে "left as you made it"।
- [ ] **হাত না দিলে conflict নেই:** AE-তে কিছু না বদলে শুধু playhead সরিয়ে Update পাঠান। কোনো conflict সতর্কতা আসে না।
- [ ] ⚠ **Illustrator-এ একই পরীক্ষা:** Illustrator-এ item-এর রং বা একটা point বদলে Update পাঠান, দুটো অপশন দিয়েই। Keep my edits-এ আপনার বদলানো item-টাই থাকে, আর Overwrite-এ নতুনটা বসে।
- [ ] ⚠ **সেভ করে খোলার পরও:** AE প্রোজেক্ট বা Illustrator ফাইল সেভ করে বন্ধ করুন, আবার খুলে কিছু না বদলে Update পাঠান। **ভুল করে conflict দেখানো উচিত না।** দেখালে জানাবেন, কারণ তার মানে সেভের পর কোনো মান একটু বদলে যায়।
- [ ] আগের সংস্করণে তৈরি layer-এ (যাদের ট্যাগে `~` নেই) conflict আসে না; পরের Update থেকে তারাও ধরা পড়ে।
- [ ] Photoshop বা Figma-তে পাঠালে Update হয় না, সবসময় যোগ হয়। তাই ওখানে conflict-এর প্রশ্নই নেই।

**Live sync: কাজ করতে করতে পাঠানো**

- [ ] **Figma → AE:** কিছু সিলেক্ট করে Send বোতামের নিচে **"Live — send changes as you work"** টিক দিন। প্রথমবার সব যায়, আর লেখা আসে "Live: keeping N objects in step…"। এবার Figma-তে ওগুলো সরান, রং বা লেখা বদলান। প্রায় আধা সেকেন্ড পরে AE-তে একই বদল দেখা যায়, আর নতুন layer তৈরি হয় না।
- [ ] Live চালু থাকা অবস্থায় Figma-তে **অন্য কিছু** সিলেক্ট করলে কিছু বদলায় না। Live সেই জিনিসগুলোই দেখে যেগুলো চালু করার সময় সিলেক্ট করা ছিল।
- [ ] দ্রুত টেনে সরালে বা টাইপ করলে প্রতিটা ধাপে আলাদা করে পাঠায় না। থামার পর একবার পাঠায়। একটা পাঠানো চলার সময় আরেকটা বদল এলে সেটা হারায় না, পরে যায়।
- [ ] দেখা জিনিসগুলো মুছে ফেললে Live নিজে বন্ধ হয়, আর লেখা আসে "Live stopped: the objects it was keeping in step are gone"।
- [ ] ⚠ **AE / Illustrator / Photoshop প্যানেল থেকে:** প্যানেলে টার্গেট বেছে **Live** টিক দিন। প্যানেল প্রতি দেড় সেকেন্ডে সিলেকশন দেখে, আর বদল পেলে পাঠায়। AE-তে layer সরান, Illustrator-এ path বদলান, Photoshop-এ layer সরান বা রং বদলান। গন্তব্যে বদলটা আসে কিনা দেখুন। কাজ করার সময় অ্যাপ আটকে যাচ্ছে বা ধীর লাগছে কিনা খেয়াল রাখুন (বিশেষ করে Illustrator-এ বড় সিলেকশনে)।
- [ ] AE-তে শুধু playhead সরালে Live কিছু পাঠায় না।
- [ ] Illustrator-এ text-এর ভেতরে টাইপ করার সময় পাঠায় না। টাইপ শেষ করে বাইরে ক্লিক করলে পাঠায়।
- [ ] Bridge বন্ধ করলে বা গন্তব্য অ্যাপের প্যানেল বন্ধ করলে Live নিজে বন্ধ হয়, আর কারণ লেখা থাকে।
- [ ] Live-এর পাঠানোগুলো History-তে জমে না; সেগুলো শুধু log-এ থাকে।
- [ ] Live সবসময় খোলা document/comp-এ **Update** করে, Options-এর Existing বা Destination যা-ই থাকুক।

## রিভিউয়ের পরের ফিক্স (v0.8.1): আসল অ্যাপে যাচাই

এগুলো মক টেস্টে ঠিক আছে, কিন্তু আসল অ্যাপের আচরণের উপর নির্ভর করে:

- [ ] ⚠ **Illustrator-এ অন্য layer-এর আর্টওয়ার্ক:** ডকুমেন্টে দুটো layer রাখুন, উপরেরটায় আপনার নিজের কিছু আঁকুন, আর নিচেরটা active রাখুন। Figma থেকে Add দিয়ে পাঠান, তারপর Update দিন। **আপনার নিজের আঁকা জিনিস মুছে যাওয়া বা বদলে যাওয়া উচিত না।**
- [ ] ⚠ **AE, Groups দিয়ে পাঠিয়ে Update:** Hierarchy = Groups দিয়ে একটা group পাঠান, যাতে null parent তৈরি হয়। কিছু না বদলে Update দিন। layer-গুলো লাফিয়ে সরে যাওয়া উচিত না।
- [ ] ⚠ **Photoshop-এ সিলেকশন:** তিনটে layer (একটা shape সহ) সিলেক্ট করে পাঠান। পাঠানোর পরেও তিনটেই সিলেক্ট থাকার কথা।
- [ ] ⚠ **Photoshop shape:** একটা shape layer-এ stroke দিন আর fill বন্ধ রাখুন, তারপর পাঠান। গন্তব্যে শুধু stroke আসার কথা। দুটো ওভারল্যাপ করা আয়তক্ষেত্র (Combine) পাঠালে মাঝখানে ফুটো হওয়া উচিত না।
- [ ] ⚠ **Photoshop-এ Undo:** Figma থেকে Photoshop-এ পাঠান, তারপর একবার Ctrl+Z দিন। পুরো ট্রান্সফার একবারেই সরে যাওয়ার কথা (History-তে একটাই "LazyLord Import")।
- [ ] **Photoshop text-এর সাইজ:** Free Transform দিয়ে বড় করা text পাঠান। গন্তব্যে সাইজ ঠিক আসার কথা।
- [ ] **Blend mode উল্টো দিকে:** AE, Illustrator বা Photoshop-এ Multiply দেওয়া layer অন্য অ্যাপে পাঠান। Multiply থাকার কথা (আগে বাদ পড়ত)।
- [ ] **Figma-তে গ্রহণ:** Illustrator থেকে একটা ঘোরানো ছবি আর একটা clipping group, "New — source page size" দিয়ে Figma-তে পাঠান। ছবি ঠিক জায়গায় ঘোরানো অবস্থায় আসে, clip কাজ করে, আর সবকিছু আর্টবোর্ডে যেখানে ছিল সেখানেই বসে।
- [ ] **Figma-র দুটো আলাদা ফাইল:** দুটো ফাইল থেকে একই ধরনের জিনিস AE-তে পাঠান (প্রথমে Add, তারপর দ্বিতীয় ফাইল থেকে Update)। দ্বিতীয় ফাইলের জিনিস প্রথমটার layer বদলে দেওয়া উচিত না।
- [ ] **Live টার্গেট:** Photoshop বা "All apps" বেছে Live চালু করলে সেটা চালু হয় না, আর কারণ লেখা আসে।

## Photoshop আর Figma-তে Update ও Live (v0.9) — ✅ ২০২৬-০৯-১৬-এ আসল অ্যাপে চালানো হয়েছে

আগে এই দুটো অ্যাপে পাঠালে সবসময় নতুন করে যোগ হতো। এখন After Effects আর Illustrator-এর মতোই Update, Live আর conflict কাজ করার কথা।

- [ ] ⚠ **Photoshop, ট্যাগ টেকে কিনা (সবার আগে):** Illustrator বা Figma থেকে একটা shape Photoshop-এ পাঠান (Existing = Add)। PSD সেভ করে বন্ধ করুন, আবার খুলুন। তারপর source-এ shape-টা সরিয়ে Existing = **Update** দিয়ে পাঠান। নতুন লেয়ার যোগ না হয়ে পুরোনোটাই বদলে যাওয়ার কথা। যোগ হলে জানাবেন: তার মানে Photoshop লেয়ারের XMP সেভ করে রাখছে না।
- [ ] **Photoshop, জায়গা ঠিক থাকে:** Update-এ লেয়ারটা নিজের জায়গাতেই থাকে (উপরে উঠে আসে না), আর আপনার বানানো group-এর ভেতরে থাকলে সেখানেই থাকে।
- [ ] **Photoshop conflict:** Photoshop-এ লেয়ারটা হাতে সরান, তারপর Update দিন। On conflict = Keep my edits হলে আপনার বদলটাই থাকে, Overwrite হলে নতুনটা বসে। দুই ক্ষেত্রেই সতর্কতা আসে।
- [ ] **Figma, Update:** Illustrator বা AE থেকে কিছু Figma-তে পাঠান। তারপর source-এ বদলে Existing = Update দিয়ে পাঠান। Figma-তে পুরোনোটাই বদলায়, নতুন কপি যোগ হয় না।
- [ ] **Figma, সরানো জিনিস:** Figma-তে আসা জিনিসটা হাতে একটা frame-এর ভেতরে টেনে নিন, তারপর Update দিন। সেটা ওই frame-এর ভেতরেই আপডেট হওয়ার কথা।
- [ ] **Figma conflict:** Figma-তে রং বদলে Update দিন। Keep my edits হলে আপনার রংটাই থাকে।
- [ ] **Live → Photoshop / Figma:** Illustrator বা AE-র প্যানেলে টার্গেট Photoshop বা Figma রেখে Live চালু করুন। আর্টওয়ার্ক বদলালে গন্তব্যে একটা কপিই আপডেট হতে থাকে, নতুন কপি জমে না।
- [ ] Figma প্লাগিনে "All apps" বেছে Live চালু করা যায় না, কারণ লেখা আসে।

## প্যাকেজ করা ইনস্টল (v1.0) — ✅ ২০২৬-০৯-১৬-এ আসল অ্যাপে চালানো হয়েছে

এটা ব্যবহারকারী যা পাবে ঠিক সেটাই পরীক্ষা করা। **একটা কথা আগে জেনে নিন:**
এই ইনস্টল ডেভেলপার ইনস্টলের জায়গাটাই নেয়, অর্থাৎ রিপোর ফোল্ডারের সঙ্গে যে
লিংকটা ছিল সেটা মুছে যায় — কোড বদলালে আর নিজে থেকে প্যানেলে আসবে না। আগের
অবস্থায় ফিরতে শুধু `install.bat` আবার চালাবেন।

- [ ] `npm run release` চালান। শেষে **"Signature verified successfully"** আসতে হবে।
- [ ] `release/LazyLord-1.0.0.zip` অন্য কোথাও (যেমন ডেস্কটপে) খুলুন।
- [ ] Photoshop, Illustrator, After Effects বন্ধ করে `Install LazyLord.bat` চালান।
- [ ] ⚠ **তিনটে অ্যাপেই প্যানেল খোলে?** Window → Extensions (legacy) → LazyLord।
      ফাঁকা সাদা/কালো প্যানেল এলে সাইন করা প্যানেল লোড হচ্ছে না — সেটাই এখানে
      আসল পরীক্ষা। তখন `Fix a blank panel.bat` চালিয়ে আবার দেখুন, আর কোনটা
      লেগেছে সেটা জানান।
- [ ] প্যানেলের নিচে ভার্সন **1.0.0** দেখাচ্ছে, আর বিন্দুটা সবুজ হয়।
- [ ] একটা ট্রান্সফার পাঠিয়ে দেখুন — জিপ থেকে আসা প্যানেলেও সব আগের মতো চলে।
- [ ] জিপের `Figma plugin\manifest.json` ইমপোর্ট করে Figma থেকেও একবার পাঠান।
- [ ] `Uninstall LazyLord.bat` চালালে প্যানেল সরে যায়।
- [ ] শেষে `install.bat` চালিয়ে ডেভেলপার ইনস্টল ফিরিয়ে আনুন।

## Overlord-এর সমান করার ফিচার (v1.1) — আসল অ্যাপে এখনো চালানো হয়নি

সব mock টেস্টে পাস করেছে, কিন্তু নিচের ⚠ চিহ্নগুলো Adobe/Figma-র এমন আচরণের ওপর
দাঁড়িয়ে আছে যা স্ক্রিপ্টিং গাইডে নিশ্চিত করে লেখা নেই। প্রতিটা আলাদা করে দেখুন।

**After Effects-এ আসল গ্র্যাডিয়েন্ট**
- [ ] Figma থেকে তিন-চার stop-এর linear আর radial গ্র্যাডিয়েন্ট পাঠান। ⚠ Gradient Ramp নয়, shape-এর নিজের **Gradient Fill** হয় আর সব stop ঠিক রঙে থাকে? (preset লিখে প্রয়োগ করা হয়)
- [ ] আধা-স্বচ্ছ stop-এর গ্র্যাডিয়েন্ট — স্বচ্ছতা ঠিক থাকে?
- [ ] গ্র্যাডিয়েন্ট stroke — stroke-এও গ্র্যাডিয়েন্ট আসে?
- [ ] সেই shape আবার Update দিয়ে পাঠান (রং বদলে) — গ্র্যাডিয়েন্ট বদলায়?
- [ ] AE → Illustrator: LazyLord-এর বানানো গ্র্যাডিয়েন্ট shape ফেরত পাঠালে রং আসে?

**Photoshop → After Effects / Figma**
- [ ] Clipping mask (একটা ছবির ওপর দুটো লেয়ার clip করা)। ⚠ AE-তে base-এর ওপর alpha track matte হয়, base নিজে দেখা যায়? AE 2023+ আর পুরোনো ভার্সনে দুটোতেই।
- [ ] Layer mask (নরম কিনারা সহ)। AE-তে luma matte, Figma-তে mask — কিনারা ঠিক?
- [ ] Gradient fill layer (৩ stop, কোণ ৩০°)। কোণ আর রং মেলে?
- [ ] Layer style: drop shadow, outer glow, stroke, colour overlay, bevel। ⚠ AE-তে Layer Styles-এ ঠিক মানসহ আসে? (Layer ▸ Layer Styles কমান্ড দিয়ে যোগ করা হয়)
- [ ] একই style একটা **pixel layer**-এ দিয়ে AE-তে পাঠান। ⚠ AE-তে ছবির ওপর আলাদা Layer Styles আসে, আর ছবির ভেতরে shadow দুবার দেখা যায় না? (style সরানো হয় শুধু PS-এর অস্থায়ী কপি থেকে — আপনার লেয়ার অক্ষত থাকার কথা)
- [ ] Adjustment layer: Brightness/Contrast, Levels, Hue/Saturation, Photo Filter, Color Balance। ⚠ AE-তে adjustment layer-এ ঠিক effect আর মান? নিচের লেয়ারগুলো একই রকম দেখায়?
- [ ] Curves adjustment — রিপোর্ট হয়, কিছু বানায় না?

**Figma component → After Effects precomp**
- [ ] একটা Button component আর তার তিনটে instance (লেখা আলাদা, একটায় রং আলাদা) — Hierarchy: **Precomps**।
- [ ] ⚠ Project-এ একটাই "Button" comp হয়, চারটে precomp লেয়ার সেটাকেই দেখায়?
- [ ] ⚠ প্রতিটা লেয়ারের **Essential Properties**-এ নিজের লেখা আর রং বসানো থাকে, আর comp-এর ভেতরে গিয়ে দেখলে Essential Graphics প্যানেলে "Label" আর রঙের প্রপার্টি দেখা যায়?
- [ ] আলাদা মাপের instance — "Button 2" নামে আলাদা precomp হয়?

**Figma: ছবি হিসেবে পাঠানো, ব্রাউজার, kerning**
- [ ] একটা গ্রুপ সিলেক্ট করে "Send the selected layers as images" টিক দিন, পাঠান — একটা ছবি হয়ে যায়? ফাইল সেভ করে আবার খুললেও টিকটা থাকে?
- [ ] Figma Community-র প্লাগিন (রিভিউ পাস হলে) Chrome-এ চালান। ⚠ ব্রাউজার "অন্য অ্যাপে যাওয়ার অনুমতি" চাইলে Allow দিলে সংযোগ সবুজ হয়? Safari-তে না হলে সেটাই প্রত্যাশিত।
- [ ] Illustrator-এ "AVATAR" লিখে Optical kerning আর A-V জোড়ায় হাতে -80 kern দিন, AE-তে পাঠান। ⚠ AE 24.3+-এ Character panel-এ Optical আর সেই জোড়ায় -80 দেখায়? (ধরে নিয়েছি একটা অক্ষরের kerning মানে তার আগের ফাঁক — উল্টো হলে পাশের জোড়ায় বসবে)
- [ ] একই লেখা Figma-তে পাঠান — জোড়ার ফাঁক Illustrator-এর মতো দেখায়?

**Illustrator আর Photoshop-এ effect**
- [ ] Figma-তে একটা ellipse-এ Layer blur 8, Drop shadow (কালো 25%, y 4, blur 10) আর Inner shadow দিয়ে Illustrator-এ পাঠান। ⚠ Appearance panel-এ **Gaussian Blur** আর **Drop Shadow** live effect আসে, মাপ Figma-র মতো দেখায়? Inner shadow রিপোর্ট হয়?
- [ ] একই জিনিস Photoshop-এ। ⚠ লেয়ারটা smart object হয়ে **Gaussian Blur** smart filter পায়, আর Layer Style-এ Drop Shadow ও Inner Shadow ঠিক কোণ/দূরত্ব/মাপে আসে?
- [ ] রঙিন (লাল) shadow Illustrator-এ কালো হয়ে আসে আর সেটা রিপোর্ট হয়?

**Figma-তে আসা ট্রান্সফার (Figma রিভিউয়ের জন্য)**
- [ ] Illustrator থেকে Figma-তে পাঠান। ক্যানভাসে কিছু না বসে প্লাগিনে **Incoming** কার্ড আসে (কোন অ্যাপ, কত লেয়ার)?
- [ ] **Place on canvas** চাপলে তবেই বসে, আর Illustrator-এর প্যানেলে ফল দেখায়?
- [ ] আবার পাঠিয়ে **Decline** চাপুন: কিছু বসে না, Illustrator-এ "Declined in Figma" দেখায়?
- [ ] Adobe প্যানেলে টার্গেট Figma রেখে **Live** টিক দিন, তারপর লেয়ার কয়েকবার সরান। Figma-তে নিজে থেকে কিছু না বদলে **একটাই** কার্ড আসে ("3 Live changes…")?
- [ ] **Update on canvas** চাপলে সর্বশেষ অবস্থাটা বসে, আর প্যানেলে "Figma applied the Live changes" দেখায়? এরপর আবার সরালে নতুন কার্ড আসে?
- [ ] **Discard** চাপলে কিছু বসে না, আর পরের বদলে কার্ড আবার আসে?

**After Effects: সেভ না করা প্রজেক্ট**
- [ ] নতুন, **সেভ না করা** AE প্রজেক্টে Photoshop থেকে একটা pixel layer (ছবি) পাঠান। কিছুই যোগ না হয়ে বার্তা আসে **"Save the After Effects project first…"**?
- [ ] প্রজেক্ট সেভ করে আবার পাঠান — ছবি প্রজেক্টের পাশে **LazyLord Assets** ফোল্ডারে যায়, আর AE-তে সেখান থেকেই link হয়?
- [ ] সেভ না করা প্রজেক্টে শুধু shape বা লেখা পাঠান — আগের মতোই চলে যায়?

**After Effects: ছবির ফোল্ডার আর frame sequence**
- [ ] AE প্যানেলে Images → Choose… দিয়ে একটা ফোল্ডার বাছুন (⚠ ফোল্ডার বাছার উইন্ডো খোলে?), তারপর ছবিসহ কিছু পাঠান — ছবি সেই ফোল্ডারে যায়? Default চাপলে আবার প্রজেক্টের পাশে?
- [ ] Photoshop-এ ৮টা লেয়ারের একটা গ্রুপ (বেশিরভাগ hidden), Options-এ **Layers as frames** টিক দিয়ে AE-তে পাঠান। ⚠ AE-তে একটাই footage হয়ে ৮ ফ্রেমের sequence চলে, comp-এর frame rate-এ? সেভ করা প্রজেক্টে "… frames" ফোল্ডারে ফ্রেমগুলো কপি হয়?

## প্যানেলে আপডেটের খবর (v1.1.8–1.1.10) — আসল অ্যাপে এখনো চালানো হয়নি

প্যানেল দিনে দুবার GitHub-এ দেখে নতুন রিলিজ এসেছে কিনা। mock টেস্টে পাস করেছে, ব্রাউজারে GitHub-এর
আসল উত্তর দিয়ে, আর Node-এ API-র সীমা ফুরিয়ে যাওয়া অবস্থায়ও চালানো হয়েছে। Adobe অ্যাপের ভেতর থেকে
GitHub-এ পৌঁছাতে পারে কিনা, সেটাই দেখার বাকি।

সবচেয়ে সহজ পরীক্ষা: আগে **1.1.9** বসান (GitHub Releases-এ আছে), তারপর 1.1.10।

- [ ] ⚠ 1.1.9 বসানো প্যানেল খুলে কয়েক সেকেন্ড অপেক্ষা করুন। উপরে "LazyLord 1.1.10 is out" কার্ড আসে, তাতে রিলিজের পয়েন্ট থাকে? তিনটে অ্যাপেই দেখুন। কার্ড না এলে হেডারে লোগোর পাশের ভার্সনে ক্লিক করে Log-এর শেষ লাইনটা পাঠান।
- [ ] **Download** চাপলে ব্রাউজারে 1.1.10-এর রিলিজ পেজ খোলে?
- [ ] **Later** চাপলে কার্ড সরে যায়, প্যানেল বন্ধ করে আবার খুললেও ফেরে না, কিন্তু হেডারে "v1.1.9 · update" থাকে আর তাতে ক্লিক করলে কার্ড ফেরে?
- [ ] 1.1.10 বসিয়ে ভার্সনে ক্লিক করুন। Log-এ "This is the latest LazyLord (1.1.10)." আসে?
- [ ] ⚠ তারপর `%APPDATA%\LazyLord\update.json` (macOS: `~/Library/Application Support/LazyLord/update.json`) ফাইলটা তৈরি হয়েছে? তিনটে অ্যাপের প্যানেল এই একটা ফাইল থেকেই দুই সপ্তাহের হিসাব রাখে, যাতে তিন অ্যাপে তিনবার খবর না যায়।
- [ ] ইন্টারনেট বন্ধ করে আবার ক্লিক করুন। Log-এ "Could not check for updates: …" আসে (কারণটা যা-ই লেখা থাকুক), আর প্যানেলের বাকি সব আগের মতো চলে?
- [ ] "Check for updates"-এর টিক তুলে প্যানেল বন্ধ করে আবার খুলুন। টিক তোলাই থাকে?

## কিছু ভুল হলে যা পাঠাবেন

1. উৎস অ্যাপ আর গন্তব্য অ্যাপের পাশাপাশি **স্ক্রিনশট**।
2. প্যানেলের **log আর সতর্কতার তালিকা**: প্যানেল থেকে লেখাটা কপি করুন।
3. **Bridge উইন্ডোর** শেষ কয়েকটা লাইন।
4. সেই ট্রান্সফারের **IR ফাইল**: `%TEMP%\lazylord\` ফোল্ডারের সবচেয়ে নতুন সাব-ফোল্ডারের `ir.json`।
5. `install.bat`-এর কোনো `[warn]` বা `[!]` লেখা থাকলে সেটাও।
6. প্যানেল একেবারেই না খুললে: Chrome-এ `http://localhost:8770` (Photoshop), `8771` (Illustrator) বা `8772` (After Effects) খুলে Console-এর লাল error-গুলোর স্ক্রিনশট।

## আনইনস্টল

`install.bat /uninstall` চালালে Adobe প্যানেল সরে যায়। Figma-তে প্লাগিনটা Plugins → Development → Manage plugins in development থেকে সরান।
