
import "dotenv/config";
import express from "express";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const BOSON_API_KEY = process.env.BOSON_API_KEY;

app.get("/api/token", async (_req, res) => {
  if (!BOSON_API_KEY) {
    return res.status(500).json({
      error: "BOSON_API_KEY is missing from the root .env file",
    });
  }

  try {
    const response = await fetch(
      "https://api.boson.ai/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BOSON_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expires_after: { seconds: 600 },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Boson token request failed:", response.status);
      return res.status(response.status).json({
        error: "Could not create a Boson session token",
      });
    }

    return res.json({
      value: data.value,
      expires_at: data.expires_at,
    });
  } catch (error) {
    console.error("Token endpoint error:", error);
    return res.status(502).json({
      error: "Could not reach the Boson API",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Token server running at http://localhost:${PORT}`);
});
