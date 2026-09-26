const express = require('express');
const multer = require('multer');
const cors = require('cors');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.NSFWINFRA_API_KEY;

function styleText(style) {
  const map = {
    'Anime Game Art': 'high quality anime game art, polished character illustration, clean linework, detailed shading',
    'Cinematic': 'cinematic lighting, dramatic composition, detailed scene, high impact visual',
    'Illustration': 'stylized illustration, polished artwork, expressive detail',
    'Realistic': 'realistic rendering, detailed skin, natural lighting, realistic proportions'
  };
  return map[style] || style;
}

function buildPrompt(userPrompt, style) {
  return `${userPrompt}, ${styleText(style)}`;
}

app.post('/api/generate', async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: 'NSFWINFRA_API_KEY not configured' });
    }

    const { prompt, aspect, style } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const finalPrompt = buildPrompt(prompt, style || 'Anime Game Art');

    const payload = {
      prompt: finalPrompt,
      aspect_ratio: aspect || '9:16',
      num_images: 2
    };

    const response = await fetch('https://api.nsfwinfra.com/v1/images/generate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const images = normalizeImages(data);
    return res.json({ ok: true, images, raw: data });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'generate failed' });
  }
});

app.post('/api/edit', upload.array('images', 3), async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: 'NSFWINFRA_API_KEY not configured' });
    }

    const files = req.files || [];
    const { prompt, aspect, style } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (!files.length) {
      return res.status(400).json({ error: 'at least one image is required' });
    }

    const form = new FormData();
    form.append('prompt', buildPrompt(prompt, style || 'Anime Game Art'));
    form.append('aspect_ratio', aspect || '9:16');
    form.append('num_images', '2');

    files.forEach((file, idx) => {
      const blob = new Blob([file.buffer], { type: file.mimetype || 'image/png' });
      form.append('images', blob, file.originalname || `image-${idx + 1}.png`);
    });

    const response = await fetch('https://api.nsfwinfra.com/v1/images/edit', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      },
      body: form
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const images = normalizeImages(data);
    return res.json({ ok: true, images, raw: data });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'edit failed' });
  }
});

function normalizeImages(data) {
  if (Array.isArray(data?.images)) return data.images;
  if (Array.isArray(data?.data)) return data.data;
  if (data?.image) return [{ image: data.image }];
  if (data?.url) return [{ url: data.url }];
  return [];
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
