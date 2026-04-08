import "dotenv/config";
/**
 * Nexvill Pricing Monitor — Configuration
 */

export const config = {
  email: {
    enabled: true,

    from: `${process.env.APP_NAME} Pricing Monitor <${process.env.EMAIL_FROM_ADDRESS}>`,
    to: process.env.EMAIL_TO,

    smtp: {
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      user: process.env.EMAIL_USER,  // your Gmail address
      pass: process.env.EMAIL_PASSWORD, // ← paste your 16-char app password here (no spaces)
    },
  },
};
