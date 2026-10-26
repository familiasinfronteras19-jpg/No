const urlCsv = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRD5Ys4_DIhIyVhq4LjxbCnUVkmpd7IcAJ4wbHtwUpwG9BZroH6jHXI5I0dHrxQeU0w7mfg0SSTt9Y5/pub?output=csv';
const CLAVE_HASH = 'tareas_ultimo_hash';
const INTERVALO_MS = 60 * 1000; // revisa cada minuto mientras la app está abierta

const esApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// Evita que el texto de la hoja pueda inyectar HTML
function escapar(texto) {
    return texto.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hashTexto(texto) {
    let h = 0;
    for (let i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) | 0;
    return String(h);
}

function pintarTareas(textoCsv) {
    const filas = textoCsv.split('\n');
    let listaHTML = '<ul>';
    for (let i = 1; i < filas.length; i++) {
        const filaLimpia = filas[i].trim();
        if (filaLimpia === '') continue;
        listaHTML += `<li><h2>${escapar(filaLimpia.replace(/,/g, ' — '))}</h2></li>`;
    }
    listaHTML += '</ul>';
    document.getElementById('contenedor-tareas').innerHTML = listaHTML;
}

async function notificar(titulo, cuerpo) {
    try {
        if (esApp) {
            const { LocalNotifications } = window.Capacitor.Plugins;
            await LocalNotifications.schedule({
                notifications: [{ id: Date.now() % 2147483647, title: titulo, body: cuerpo }]
            });
        } else if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(titulo, { body: cuerpo, icon: 'icon.png' });
        }
    } catch (e) {
        console.error('No se pudo mostrar la notificación', e);
    }
}

async function pedirPermisos() {
    try {
        if (esApp) {
            await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
            // Permiso para las notificaciones del proceso en segundo plano
            if (window.Capacitor.Plugins.BackgroundRunner) {
                await window.Capacitor.Plugins.BackgroundRunner.requestPermissions({ apis: ['notifications'] });
            }
        } else if ('Notification' in window && Notification.permission === 'default') {
            await Notification.requestPermission();
        }
    } catch (e) {
        console.error('Error pidiendo permisos', e);
    }
}

async function obtenerTareasDelDrive() {
    try {
        // Parámetro aleatorio para evitar que se use una copia en caché
        const respuesta = await fetch(`${urlCsv}&t=${Date.now()}`, { cache: 'no-store' });
        if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);
        const textoCsv = await respuesta.text();

        const nuevoHash = hashTexto(textoCsv);
        const anterior = localStorage.getItem(CLAVE_HASH);

        pintarTareas(textoCsv);

        if (anterior !== null && anterior !== nuevoHash) {
            notificar('📝 Tareas actualizadas', 'Hay cambios en tu hoja de cálculo.');
        }
        localStorage.setItem(CLAVE_HASH, nuevoHash);
    } catch (error) {
        const caja = document.getElementById('contenedor-tareas');
        if (!caja.querySelector('ul')) caja.innerText = '❌ Error al cargar las tareas.';
        console.error('Error detallado:', error);
    }
}

async function iniciar() {
    await pedirPermisos();
    obtenerTareasDelDrive();
    setInterval(obtenerTareasDelDrive, INTERVALO_MS);

    // Al volver a abrir la app / la pestaña, revisa al instante
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) obtenerTareasDelDrive();
    });
}

iniciar();

if ('serviceWorker' in navigator && !esApp) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}
