import multer from 'multer';
import { Request } from 'express';
import logger from '../utils/logger';

// 配置 multer 使用内存存储
// 文件存储在内存中的 Buffer，直接上传到 Cloudinary
const storage = multer.memoryStorage();

// 文件过滤器：只允许图片类型
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/png',
    'image/webp'
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    logger.warn('拒绝不支持的文件类型', {
      originalname: file.originalname,
      mimetype: file.mimetype
    });
    cb(new Error(`不支持的文件类型: ${file.mimetype}。支持的格式: JPG, PNG, WebP`));
  }
};

// 创建 multer 实例
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB 文件大小限制
    files: 1                   // 单次只允许上传一个文件
  }
});

// 单文件上传中间件
// 字段名为 'logo'（用于票据logo上传）
export const uploadSingleLogo = upload.single('logo');

// 字段名为 'image'（用于打印设置logo上传）
export const uploadSingleImage = upload.single('image');

export default upload;
