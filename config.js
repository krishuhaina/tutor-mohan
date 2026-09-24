/* =====================  EDIT THIS FILE  =====================
   Everything you need to customise lives here. */
window.MEETING_CONFIG = {
  /* ---------- Branding ---------- */
  APP_NAME: "tutor Mohan",             // plain name (browser tab, attendance file)
  NAME_PARTS: [                         // the coloured name shown on screen: one entry per word
    { text: "tutor", color: "#0a1f5c" }, // navy blue
    { text: "Mohan", color: "#ff5500" }  // orange
  ],
  TAGLINE: "Live online classes",        // small line under the name on the join screen
  WELCOME_TEXT: "Welcome! Enter your name to join today's class.",
  LOGO: "tutormohan-6aaf4a81d3d3d9.46707183.jpeg",                       // an emoji, OR a picture file you upload (logo.svg / logo.png)
  BRAND_COLOR: "#ff5500",                // colour of buttons and highlights (any hex colour)
  TEACHER_LABEL: "",                     // optional: name students see on your video, e.g. "Mohan Sir". Empty = the name you type at login
  FOOTER_TEXT: "",                       // optional small text at the bottom of the join screen, e.g. "© 2026 Mohan Tutorials"

  /* ---------- Room & security ---------- */
  ROOM: "SampleAppWorseParkingsCutOpenly", // default room. Make it long and random!
  NAMESPACE: "tutormohan",                 // unique to you (letters/numbers/dashes)

  // TEACHERS: one entry per teacher. Each teacher has their OWN passcode.
  //   name  = shown to students and written in attendance/recording file names
  //   hash  = SHA-256 of that teacher's passcode. Make it with make-passcode-hash.html
  //   rooms = (optional) only these rooms can be hosted with this passcode
  // To remove a teacher, delete their line and upload config.js again. Their passcode stops working.
  // (The first hash below = "change-me-123". The app warns you until you replace it.)
  TEACHERS: [
    { name: "Mohan Sir",  hash: "8eb2961d9750214f76ff37133422ee3f48100588caa32566007a6d33bea8b5fc" },
    // { name: "Priya Madam", hash: "PASTE-HASH-HERE", rooms: ["maths-batch-a", "maths-batch-b"] },
  ],

  /* ---------- Optional ---------- */
  PUBLIC_URL: "",            // e.g. "https://YOURNAME.github.io/REPO/". Empty = automatic
  EXTRA_ICE_SERVERS: []      // TURN server for strict school networks, e.g. { urls: "turn:host:3478", username: "u", credential: "p" }
};
