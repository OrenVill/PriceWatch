import "dotenv/config";

export const config = {
  apiKey: process.env.PRICEWATCH_API_KEY,
  appName: process.env.APP_NAME || "PriceWatch",
  aws: {
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET_NAME,
  },
  email: {
    from: `${process.env.APP_NAME || "PriceWatch"} <${process.env.EMAIL_FROM_ADDRESS}>`,
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
