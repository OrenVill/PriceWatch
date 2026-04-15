import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME;

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJson(key) {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await streamToString(res.Body);
    return JSON.parse(body);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function writeJson(key, value) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(value, null, 2),
    ContentType: "application/json",
  }));
}

export async function getSubscribers() {
  return (await readJson("subscribers.json")) ?? [];
}

export async function saveSubscribers(subscribers) {
  await writeJson("subscribers.json", subscribers);
}

export async function getPrices() {
  return await readJson("prices.json");
}

export async function savePrices(prices) {
  await writeJson("prices.json", prices);
}
