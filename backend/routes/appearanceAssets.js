const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'));
const appearanceDir = path.join(uploadsRoot, 'appearance');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

function rasterExtension(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) return '';
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
    return '';
}

router.post('/', (req, res) => {
    upload.single('image')(req, res, async error => {
        if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
            .json({ error: error.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 5 MB' : '图片上传失败' });
        const extension = rasterExtension(req.file?.buffer);
        if (!extension) return res.status(400).json({ error: '只支持 PNG、JPEG 或 WebP 图片' });
        try {
            await fs.promises.mkdir(appearanceDir, { recursive: true });
            const filename = `${crypto.randomBytes(16).toString('hex')}${extension}`;
            await fs.promises.writeFile(path.join(appearanceDir, filename), req.file.buffer, { flag: 'wx' });
            res.status(201).json({ url: `/uploads/appearance/${filename}` });
        } catch {
            res.status(500).json({ error: '图片保存失败，请检查现场存储空间' });
        }
    });
});

module.exports = router;
module.exports.rasterExtension = rasterExtension;
