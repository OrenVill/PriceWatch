import "dotenv/config";

export const config = {

  email: {
    enabled: true,
    from: `${process.env.APP_NAME} <${process.env.EMAIL_FROM_ADDRESS}>`,
    to: process.env.EMAIL_TO,
    smtp: {
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  },
};
