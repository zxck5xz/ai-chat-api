import { OCRDetector } from './ocr';
import { ImageGenerator } from './image-generator';

export { OCRDetector } from './ocr';
export { ImageGenerator } from './image-generator';

export function createImageTextServices(geminiApiKey: string) {
  return {
    ocr: new OCRDetector(geminiApiKey),
    imageGenerator: new ImageGenerator(geminiApiKey),
  };
}
