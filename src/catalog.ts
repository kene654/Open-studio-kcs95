export const FALLBACK_MODELS = {
  video: [
    {
      id: "wan2.1-1.3b",
      name: "Wan 2.1 1.3B",
      kind: "video",
      blurb: "Text-to-video on 8 GB GPUs. Add an image or video as a visual reference. Positive prompt describes what to create; negative prompt lists what to avoid.",
      attachments: ["image", "video"],
      fields: [
        { key: "prompt", label: "Positive prompt", type: "textarea", required: true, placeholder: "A red Mustang races down a wet city street at night, neon reflecting on the asphalt, cinematic camera tracking" },
        { key: "negative_prompt", label: "Negative prompt", type: "textarea", placeholder: "blurry, static, extra limbs, watermark, text, deformed car" },
        { key: "duration", label: "Duration (seconds)", type: "number", min: 2, max: 5, step: 1, defaultValue: 3 },
        { key: "aspect_ratio", label: "Aspect ratio", type: "select", options: ["16:9", "9:16", "1:1"], defaultValue: "16:9" },
      ],
    },
  ],
  image: [
    {
      id: "sdxl-turbo",
      name: "SDXL Turbo",
      kind: "image",
      blurb: "Fast local image generation. Fits 8 GB VRAM. Use a positive prompt for what you want and a negative prompt for what to leave out.",
      attachments: ["image"],
      fields: [
        { key: "prompt", label: "Positive prompt", type: "textarea", required: true, placeholder: "A red Mustang parked under rain-soaked neon, cinematic still, sharp details" },
        { key: "negative_prompt", label: "Negative prompt", type: "textarea", placeholder: "blurry, extra wheels, watermark, text, low quality" },
        { key: "aspect_ratio", label: "Aspect ratio", type: "select", options: ["16:9", "9:16", "1:1"], defaultValue: "1:1" },
      ],
    },
  ],
  audio: [
    {
      id: "kokoro-tts",
      name: "Kokoro 82M",
      kind: "audio",
      blurb: "Local open-source text-to-speech. Light enough to stay on CPU.",
      fields: [
        { key: "prompt", label: "Script", type: "textarea", required: true, placeholder: "Welcome to Open-Studio, powered by KenStudios95." },
        { key: "voice", label: "Voice", type: "select", options: ["af_heart", "af_bella", "am_adam", "am_michael", "bf_emma", "bm_george"], defaultValue: "af_heart" },
        { key: "speed", label: "Speed", type: "number", min: 0.7, max: 1.4, step: 0.1, defaultValue: 1 },
      ],
    },
    {
      id: "musicgen-small",
      name: "MusicGen Small",
      kind: "audio",
      blurb: "Open-source music from a text prompt. Facebook MusicGen, local weights.",
      fields: [
        { key: "prompt", label: "Prompt", type: "textarea", required: true, placeholder: "Dark industrial pulse, red-lit warehouse, slow analog bass" },
        { key: "duration", label: "Duration (seconds)", type: "number", min: 4, max: 15, step: 1, defaultValue: 8 },
      ],
    },
  ],
};
