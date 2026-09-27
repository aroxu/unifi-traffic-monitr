import type { NextConfig } from 'next';
const config: NextConfig = {transpilePackages: ['@utm/db', '@utm/contracts']};
export default config;
