# LazyLord — লাইভ টেস্ট চেকলিস্ট (v0.7)

এই সংস্করণের সব কোড শুধু নকল (mock) Adobe/Figma পরিবেশে টেস্ট করা হয়েছে। আসল অ্যাপে প্রথমবার চালিয়ে দেখার জন্য এই তালিকা।
**⚠ চিহ্ন দেওয়া ঘরগুলো সবচেয়ে জরুরি।** এগুলো ডকুমেন্টেশন দেখে লেখা অনুমান, আসল অ্যাপ ছাড়া নিশ্চিত হওয়ার উপায় নেই।

## ০. সেটআপ

- [ ] `install.bat` ডাবল-ক্লিক করুন। শেষে "Installed." লেখা আসে কিনা দেখুন। কোনো `[warn]` বা `[!]` এলে সেই লেখাটা কপি করে রাখুন।
- [ ] "LazyLord bridge" নামে একটা উইন্ডো খোলে, আর তাতে `bridge listening on ws://127.0.0.1:7878` লেখা থাকে।
- [ ] Photoshop, Illustrator আর After Effects রিস্টার্ট করুন। প্রতিটায় **Window → Extensions (legacy) → LazyLord** খোলে, আর উপরের ডটটা সবুজ হয়।
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

## কিছু ভুল হলে যা পাঠাবেন

1. উৎস অ্যাপ আর গন্তব্য অ্যাপের পাশাপাশি **স্ক্রিনশট**।
2. প্যানেলের **log আর সতর্কতার তালিকা**: প্যানেল থেকে লেখাটা কপি করুন।
3. **Bridge উইন্ডোর** শেষ কয়েকটা লাইন।
4. সেই ট্রান্সফারের **IR ফাইল**: `%TEMP%\lazylord\` ফোল্ডারের সবচেয়ে নতুন সাব-ফোল্ডারের `ir.json`।
5. `install.bat`-এর কোনো `[warn]` বা `[!]` লেখা থাকলে সেটাও।
6. প্যানেল একেবারেই না খুললে: Chrome-এ `http://localhost:8770` (Photoshop), `8771` (Illustrator) বা `8772` (After Effects) খুলে Console-এর লাল error-গুলোর স্ক্রিনশট।

## আনইনস্টল

`install.bat /uninstall` চালালে Adobe প্যানেল সরে যায়। Figma-তে প্লাগিনটা Plugins → Development → Manage plugins in development থেকে সরান।
