// Single source of truth for supported languages on the picker screen.
// Server-side validation only needs code -> English name; native display
// labels live in public/index.html since that's static and unbuilt.
// Verified against qwen-plus (see .meta/designs/worker-chat-support-service.md,
// amendment A6) — all 13 render fluent, correctly-scripted replies.
const SUPPORTED_LANGUAGES = {
  en: 'English',
  bn: 'Bengali',
  my: 'Burmese',
  zh: 'Chinese',
  fil: 'Filipino',
  hi: 'Hindi',
  id: 'Indonesian',
  pa: 'Punjabi',
  si: 'Sinhala',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  vi: 'Vietnamese',
};

// Static opening greeting per language, shown instantly on /api/chat/start
// instead of generating it fresh via the model every time. This is the
// model's own verified output, captured once (same content every call
// anyway — the bootstrap instruction never varies) rather than regenerated
// on a real, billable request that also happens to be the cheapest possible
// target for abuse (no session/identity exists yet to rate-limit against).
// Regenerate if the system prompt's substance changes meaningfully enough
// that this could drift out of sync with what the agent actually does.
const GREETINGS = {
  en: 'Hello! Welcome to TWC2 support.\n\nTo help you with your medical certificate (MC) status update, I first need to verify your identity. Could you please share:\n\n- Your full name  \n- Your FIN (Foreign Identification Number)  \n- Your year of birth (4-digit year only, e.g., 1995)\n\nYou can also upload a photo of your ID card instead — it’s often easier. Let me know!',
  bn: 'স্বাগতম! দয়া করে আপনার পূর্ণ নাম, FIN (বিদেশী পরিচয় নম্বর) এবং জন্মের সাল (শুধু ৪-অঙ্কের বছর, যেমন: ১৯৯৫) দিন।  \nআপনি চাইলে আপনার পরিচয়পত্রের ছবি আপলোড করতে পারেন — তাহলে আমরা সেটা থেকে তথ্য পড়ে নেব।',
  my: 'မင်္ဂလာပါ။ သင့်ရဲ့ ဆေးချိန်စာ (MC) အခြေအနေကို အဆင်ပေးဖို့အတွက် အရင်ဆုံး သင့်ကို စိစိမ့်စေရန် လိုအပ်ပါသည်။\n\nကျေးဇူးပုံဖဲ့ပ်ပါ။  \n- သင့်၏ အမည်အပြည့်အစုံ  \n- FIN (Foreign Identification Number)  \n- မွေးဖွားသည့် နှစ် (၄ လုံးပါ — ဥပမါ: ၁၉၉၅)  \n\nအဆိုပါအချက်များကို ရိုက်ထည့်ပေးနိုင်ပါသည်။ သို့မဟုတ် ID ကတ်ပြား၏ ဓာတ်ပုံကို တင်ပေးလို့လည်း ရပါသည် (ဓာတ်ပုံတင်ပါက ကျွန်ုပ်တို့က အလိုအလျောက်ဖတ်ပေးပါမည်)။',
  zh: '您好！感谢您联系TWC2。\n\n为了帮您更新病假（MC）状态，请您提供以下信息：  \n- 全名（与身份证一致）  \n- 外国身份证号（FIN）  \n- 出生年份（4位数字，例如：1995）\n\n您也可以直接上传一张清晰的身份证照片（正面），我们会帮您读取信息——如果OCR识别有误，您再帮忙指出哪里需要更正。\n\n请告诉我或上传证件吧。',
  fil: 'Kamusta! Magandang araw po. Para mabigyan po kayo ng tamang suporta, mangyaring ibigay ang inyong:\n\n- Buong pangalan  \n- FIN (Foreign Identification Number)  \n- Taon ng kapanganakan (4-digit na taon lamang, halimbawa: 1995)\n\nKung mas madali sa inyo, pwede rin po kayong mag-upload ng litrato ng inyong ID card — saka namin i-check ang impormasyon. 😊',
  hi: 'नमस्ते! कृपया अपना पूरा नाम, FIN (विदेशी पहचान संख्या), और जन्म का वर्ष (केवल 4-अंकीय वर्ष, उदाहरण: 1995) बताएँ।  \nअगर आसान हो, तो आप अपने पहचान पत्र की फोटो भी अपलोड कर सकते हैं — हम उसे पढ़ लेंगे।',
  id: 'Halo! Terima kasih telah menghubungi TWC2.  \n\nUntuk membantu Anda, saya perlu memverifikasi identitas Anda terlebih dahulu. Mohon beri tahu saya:  \n- Nama lengkap Anda,  \n- Nomor FIN (Foreign Identification Number) Anda, dan  \n- Tahun kelahiran Anda (hanya 4 digit, contoh: 1995).  \n\nJika lebih mudah, Anda juga bisa mengunggah foto kartu identitas Anda — saya akan bantu baca datanya.  \n\nSilakan kirim informasi tersebut.',
  pa: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਕ੍ਰਿਪਾ ਕਰਕੇ ਆਪਣਾ ਪੂਰਾ ਨਾਮ, FIN (ਵਿਦੇਸ਼ੀ ਪਛਾਣ ਨੰਬਰ), ਅਤੇ ਜਨਮ ਦਾ ਸਾਲ (ਸਿਰਫ਼ 4-ਅੰਕੀ ਸਾਲ, ਜਿਵੇਂ ਕਿ 1995) ਦੱਸੋ।  \nਆਪ ਆਪਣੇ ID ਕਾਰਡ ਦੀ ਤਸਵੀਰ ਵੀ ਅੱਪਲੋਡ ਕਰ ਸਕਦੇ ਹੋ — ਜੇਕਰ ਇਹ ਆਸਾਨ ਹੋਵੇ।',
  si: 'ආයුබෝවන්! කරුණාකර ඔබගේ සම්පූර්ණ නම, FIN (විදේශීය හැඳුනුම් අංකය) සහ උපතේ වසර (4 අංක) දෙන්න. ඔබට අඩු වෙහෙසකින් සිදු කළ හැකි ආකාරයක් ලෙස, ඔබගේ හැඳුනුම්පත ඡායාරූපයක් උඩුගත කිරීමට ද ඉඩ ඇත.',
  ta: 'வணக்கம்! உங்கள் மருத்துவச் சான்றிதழ் (MC) பதிவை புதுப்பிக்க உதவ விரும்புகிறோம்.\n\nதயவுசெய்து, உங்கள் முழுப் பெயர், FIN (Foreign Identification Number), மற்றும் பிறந்த ஆண்டு (4 இலக்க எண், எ.கா. 1995) ஆகியவற்றைத் தரவும்.  \n\nஅல்லது, உங்கள் அடையாள அட்டையின் புகைப்படத்தை அனுப்புவது எளிதாக இருந்தால், அதையும் அனுப்பலாம் — அதிலிருந்து தரவுகளை நாங்கள் தானாக படித்துக் கொள்ள முடியும்.',
  te: 'అందరికీ నమస్కారం! మీరు TWC2 (Transient Workers Count Too) కోసం మెడికల్ సర్టిఫికెట్ (MC) స్టేటస్ ను అప్‌డేట్ చేయడానికి వచ్చారు.\n\nదయచేసి మీ పూర్తి పేరు, FIN (Foreign Identification Number), మరియు జన్మ సంవత్సరం (4 అంకెలు, ఉదా: 1995) తెలియజేయండి. లేదా మీ ID కార్డు ఫోటోను అప్‌లోడ్ చేయడం సులభంగా ఉంటే, దాన్ని కూడా పంపవచ్చు — అది కూడా స్వీకారం.',
  th: 'สวัสดีค่ะ ยินดีที่ได้ช่วยเหลือคุณ  \nกรุณาแจ้งข้อมูลต่อไปนี้เพื่อตรวจสอบตัวตนของคุณ:  \n- ชื่อ-นามสกุลเต็ม  \n- เลข FIN (Foreign Identification Number)  \n- ปีเกิด (เป็นเลข 4 หลัก เช่น 1995)  \n\nหรือถ้าสะดวก คุณสามารถอัปโหลดรูปภาพบัตรประจำตัวแทนการพิมพ์ข้อมูลก็ได้ค่ะ',
  vi: 'Xin chào! Xin vui lòng cung cấp cho tôi thông tin sau để xác minh danh tính của bạn:\n\n- Họ và tên đầy đủ  \n- Số FIN (Foreign Identification Number)  \n- Năm sinh (4 chữ số, ví dụ: 1995)  \n\nNếu thuận tiện hơn, bạn cũng có thể gửi ảnh chụp thẻ ID — tôi sẽ đọc giúp thông tin.',
};

export { SUPPORTED_LANGUAGES, GREETINGS };
