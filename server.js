const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', true);

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 3 }
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir));
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.NSFWINFRA_API_KEY;
const API_BASE = 'https://api.nsfwinfra.com';

function styleText(style) {
  const map = {
    'Anime Game Art': 'high quality anime game art, polished character illustration, clean linework, detailed shading',
    'Cinematic': 'cinematic lighting, dramatic composition, detailed scene, high impact visual',
    'Illustration': 'stylized illustration, polished artwork, expressive detail',
    'Realistic': 'realistic rendering, detailed skin, natural lighting, realistic proportions'
  };
  return map[style] || style || '';
}

function buildPrompt(userPrompt, style) {
  return [userPrompt, styleText(style)].filter(Boolean).join(', ');
}

function sizeFromAspect(aspect) {
  switch (aspect) {
    case '1:1':
      return { width: 1024, height: 1024 };
    case '16:9':
      return { width: 1024, height: 576 };
    case '4:5':
      return { width: 768, height: 960 };
    case '9:16':
    default:
      return { width: 576, height: 1024 };
  }
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      error: text || 'Non-JSON response'
    };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
      data?.message ||
      'API request failed'
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

async function waitForJob(id) {
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 1500));

    const job = await apiJson(
      `${API_BASE}/v1/jobs/${id}`,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`
        }
      }
    );

    if (job.status === 'completed') {
      return job;
    }

    if (
      job.status === 'failed' ||
      job.status === 'cancelled'
    ) {
      const error = new Error(
        job?.error?.message || 'Job failed'
      );

      error.status = 500;
      error.data = job;

      throw error;
    }
  }

  throw new Error('Generation timed out');
}

function jobImages(job) {
  const outputs = Array.isArray(job?.outputs)
    ? job.outputs
    : [];

  if (outputs.length) {
    return outputs
      .map(item => ({
        url: item.url
      }))
      .filter(item => item.url);
  }

  if (job?.output?.url) {
    return [
      {
        url: job.output.url
      }
    ];
  }

  return [];
}

app.post('/api/generate', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: 'NSFWINFRA_API_KEY not configured'
      });
    }

    const {
      prompt,
      aspect,
      style
    } = req.body || {};

    if (!prompt) {
      return res.status(400).json({
        error: 'prompt is required'
      });
    }

    const {
      width,
      height
    } = sizeFromAspect(aspect);

    const create = await apiJson(
      `${API_BASE}/v1/images/generate`,
      {
        method: 'POST',

        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID()
        },

        body: JSON.stringify({
          prompt: buildPrompt(
            prompt,
            style || 'Anime Game Art'
          ),
          width,
          height,
          seed: -1
        })
      }
    );

    const job = await waitForJob(create.id);

    return res.json({
      ok: true,
      images: jobImages(job),
      raw: job
    });

  } catch (err) {
    return res
      .status(err.status || 500)
      .json({
        error:
          err.data ||
          err.message ||
          'generate failed'
      });
  }
});

app.post(
  '/api/edit',
  upload.array('images', 3),
  async (req, res) => {
    const files = req.files || [];

    try {
      if (!API_KEY) {
        return res.status(500).json({
          error: 'NSFWINFRA_API_KEY not configured'
        });
      }

      const {
        prompt,
        style
      } = req.body || {};

      if (!prompt) {
        return res.status(400).json({
          error: 'prompt is required'
        });
      }

      if (!files.length) {
        return res.status(400).json({
          error: 'at least one image is required'
        });
      }

      const baseUrl =
        `${req.protocol}://${req.get('host')}`;

      const imageUrls = files.map(file => {
        return (
          `${baseUrl}/uploads/` +
          encodeURIComponent(file.filename)
        );
      });

      const create = await apiJson(
        `${API_BASE}/v1/images/edit`,
        {
          method: 'POST',

          headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID()
          },

          body: JSON.stringify({
            images: imageUrls,
            prompt: buildPrompt(
              prompt,
              style || 'Realistic'
            ),
            seed: -1
          })
        }
      );

      const job = await waitForJob(create.id);

      return res.json({
        ok: true,
        images: jobImages(job),
        raw: job
      });

    } catch (err) {
      return res
        .status(err.status || 500)
        .json({
          error:
            err.data ||
            err.message ||
            'edit failed'
        });

    } finally {
      for (const file of files) {
        try {
          fs.unlinkSync(file.path);
        } catch {}
      }
    }
  }
);

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});
