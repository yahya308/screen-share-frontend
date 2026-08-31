/**
 * Tailwind yapılandırması.
 *
 * Daha önce sayfalar cdn.tailwindcss.com'u yüklüyordu — bu, CSS'i TARAYICIDA
 * derleyen bir geliştirme aracı: her açılışta ~400 KB gereksiz JS, stil
 * hesaplanana kadar görsel titreme ve giriş sayfasında keyfi kod
 * çalıştırabilecek bir üçüncü taraf alan adı. Artık dağıtımda derlenip tek
 * bir küçük CSS dosyası olarak yayınlanıyor (npm run build).
 */
module.exports = {
    darkMode: 'class',
    content: [
        './public/**/*.html',
        './public/**/*.js'
    ],
    theme: {
        extend: {
            colors: {
                brand: {
                    300: '#7dd3fc',
                    400: '#38bdf8',
                    500: '#0ea5e9',
                    600: '#0284c7',
                    700: '#0369a1'
                }
            },
            animation: {
                'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
            }
        }
    },
    plugins: []
};
