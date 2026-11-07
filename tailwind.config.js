export default {
  content: ['./index.html', './src/client/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#17223b',
        teal: '#1e8f88',
        paper: '#f5f7f8',
      },
      fontFamily: {
        sans: ['Tahoma', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 14px 36px rgba(19, 36, 59, 0.08)',
      },
    },
  },
  plugins: [],
};
