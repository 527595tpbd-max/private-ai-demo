const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

function sizeFromRatio(ratio) {
  switch (ratio) {
    case "1:1":
      return { width: 1024, height: 1024 };
    case "3:4":
      return { width: 1024, height: 1365 };
    case "9:16":
    default:
      return { width: 1024, height: 1820 };
  }
}

app.post("/api/generate", async (req, res) => {
  try {
    if (!process.env.NSFWINFRA_API_KEY) {
      return res.status(500).json({ error: "NSFWINFRA_API_KEY not configured" });
    }

    const { prompt, ratio = "9:16", seed = -1 } = req.body || {};

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "prompt required" });
    }

    const { width, height } = sizeFromRatio(ratio);

    const createRes = await fetch("https://api.nsfwinfra.com/v1/images/generate", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NSFWINFRA_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify({
        prompt,
        model: "realistic-image-v1",
        width,
        height,
        seed
      })
    });

    const createJob = await createRes.json();

    if (!createRes.ok) {
      return res.status(createRes.status).json(createJob);
    }

    let job = createJob;

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1500));

      const pollRes = await fetch(`https://api.nsfwinfra.com/v1/jobs/${job.id}`, {
        headers: {
          "Authorization": `Bearer ${process.env.NSFWINFRA_API_KEY}`
        }
      });

      job = await pollRes.json();

      if (job.status === "completed") {
        const url = job.output?.url || job.outputs?.[0]?.url;
        return res.json({ ok: true, url, job });
      }

      if (job.status === "failed" || job.status === "cancelled") {
        return res.status(500).json(job);
      }
    }

    return res.status(202).json({
      ok: false,
      status: job.status,
      message: "Still processing. Try again shortly."
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "server error"
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PRIVATE AI running on port ${port}`);
});
