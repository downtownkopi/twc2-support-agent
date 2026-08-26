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

export { SUPPORTED_LANGUAGES };
