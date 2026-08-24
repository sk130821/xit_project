import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const backendRoot = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(backendRoot, '.env') });
