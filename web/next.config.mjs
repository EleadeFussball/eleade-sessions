/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  async redirects() {
    return [{ source: '/monday', destination: '/admin', permanent: true }];
  },
};
