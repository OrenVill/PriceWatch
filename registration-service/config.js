import "dotenv/config";

export const config = {
  apiKey: process.env.PRICEWATCH_API_KEY,
  port: parseInt(process.env.PORT || "3001", 10),
  aws: {
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET_NAME,
  },
};
