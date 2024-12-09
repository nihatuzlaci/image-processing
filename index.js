const express = require("express");
const { upload } = require("./multer");
const sharp = require("sharp");
const path = require("path");
const axios = require("axios");
const fs = require("fs").promises;

class ImageComparison {
  constructor() {
    this.app = express();
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.post(
      "/api/compare/files",
      upload.fields([
        { name: "image1", maxCount: 1 },
        { name: "image2", maxCount: 1 },
      ]),
      this.handleFileComparison.bind(this)
    );

    this.app.post(
      "/api/compare/urls",
      express.json(),
      this.handleUrlComparison.bind(this)
    );

    this.app.post(
      "/api/analyze/file",
      upload.single("image"),
      this.handleSingleImageAnalysis.bind(this)
    );

    this.app.post(
      "/api/analyze/url",
      express.json(),
      this.handleUrlImageAnalysis.bind(this)
    );
  }

  async downloadImage(url) {
    const response = await axios({
      url,
      responseType: "arraybuffer",
    });
    const fileName = `temp-${Date.now()}.jpg`;
    await fs.writeFile(path.join("uploads", fileName), response.data);
    return path.join("uploads", fileName);
  }

  async handleUrlComparison(req, res) {
    try {
      const { url1, url2 } = req.body;
      if (!url1 || !url2) {
        return res.status(400).json({ error: "Both URLs are needed!" });
      }

      const [image1Path, image2Path] = await Promise.all([
        this.downloadImage(url1),
        this.downloadImage(url2),
      ]);

      const result = await this.compareImages(image1Path, image2Path);

      await Promise.all([fs.unlink(image1Path), fs.unlink(image2Path)]);

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async handleFileComparison(req, res) {
    try {
      if (!req.files["image1"] || !req.files["image2"]) {
        return res.status(400).json({ error: "Both files are needed!" });
      }

      const result = await this.compareImages(
        req.files["image1"][0].path,
        req.files["image2"][0].path
      );

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async handleSingleImageAnalysis(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "File is required" });
      }

      const result = await this.analyzeSingleImage(req.file.path);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async handleUrlImageAnalysis(req, res) {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL is required!" });
      }

      const imagePath = await this.downloadImage(url);
      const result = await this.analyzeSingleImage(imagePath);

      await fs.unlink(imagePath);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async compareImages(image1Path, image2Path) {
    try {
      const [metadata1, metadata2] = await Promise.all([
        sharp(image1Path).metadata(),
        sharp(image2Path).metadata(),
      ]);

      const [image1Analysis, image2Analysis] = await Promise.all([
        this.analyzeSingleImage(image1Path),
        this.analyzeSingleImage(image2Path),
      ]);

      const comparison = {
        dimensionDifference: {
          width: Math.abs(metadata1.width - metadata2.width),
          height: Math.abs(metadata1.height - metadata2.height),
        },
        colorDifference: await this.compareColors(image1Path, image2Path),
        brightnessComparison: {
          difference: Math.abs(
            image1Analysis.stats.brightness - image2Analysis.stats.brightness
          ),
        },
        saturationComparison: {
          difference: Math.abs(
            image1Analysis.stats.contrast - image2Analysis.stats.saturation
          ),
        },
        dominantColors: {
          image1: image1Analysis.dominantColors,
          image2: image2Analysis.dominantColors,
        },
        contrastComparison: {
          difference: Math.abs(
            image1Analysis.stats.contrast - image2Analysis.stats.contrast
          ),
        },
      };

      return comparison;
    } catch (error) {
      throw new Error(`Comparison Error: ${error.message}`);
    }
  }

  async analyzeSingleImage(imagePath) {
    try {
      const image = sharp(imagePath);
      const metadata = await image.metadata();
      const stats = await image.stats();

      const { dominant, palette } = await this.analyzeColors(image);

      return {
        metadata: {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
          size: metadata.size,
        },
        stats: {
          brightness: stats.channels[0].mean,
          saturation: this.calculateSaturation(stats),
          contrast: this.calculateContrast(stats),
        },
        dominantColors: dominant,
        colorPalette: palette,
      };
    } catch (error) {
      throw new Error(`Error: ${error.message}`);
    }
  }

  async analyzeColors(image) {
    const { data, info } = await image
      .resize(50, 50, { fit: "cover" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = [];
    for (let i = 0; i < data.length; i += 3) {
      pixels.push({
        r: data[i],
        g: data[i + 1],
        b: data[i + 2],
      });
    }

    const colorGroups = {};
    pixels.forEach((pixel) => {
      const key = `${Math.floor(pixel.r / 10) * 10},${
        Math.floor(pixel.g / 10) * 10
      },${Math.floor(pixel.b / 10) * 10}`;
      if (!colorGroups[key]) {
        colorGroups[key] = 0;
      }
      colorGroups[key]++;
    });

    const sortedColors = Object.entries(colorGroups)
      .map(([key, count]) => ({
        rgb: key.split(",").map(Number),
        count,
      }))
      .sort((a, b) => b.count - a.count);

    const dominant = sortedColors[0].rgb;
    const palette = sortedColors.slice(0, 5).map((color) => color.rgb);

    return {
      dominant,
      palette,
      imageInfo: info,
    };
  }

  async compareColors(image1Path, image2Path) {
    const [analysis1, analysis2] = await Promise.all([
      sharp(image1Path).stats(),
      sharp(image2Path).stats(),
    ]);

    return {
      redDifference: Math.abs(
        analysis1.channels[0].mean - analysis2.channels[0].mean
      ),
      greenDifference: Math.abs(
        analysis1.channels[1].mean - analysis2.channels[1].mean
      ),
      blueDifference: Math.abs(
        analysis1.channels[2].mean - analysis2.channels[2].mean
      ),
    };
  }

  calculateSaturation(stats) {
    if (stats.channels.length < 3) return 0;
    const [r, g, b] = stats.channels;
    return Math.sqrt((r.mean ** 2 + g.mean ** 2 + b.mean ** 2) / 3);
  }

  calculateContrast(stats) {
    return stats.channels[0].stdev; // Luminance channel standard deviation
  }

  start(port = 8080) {
    this.app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  }
}

const compare = new ImageComparison();

compare.setupRoutes();
compare.start(8080);
