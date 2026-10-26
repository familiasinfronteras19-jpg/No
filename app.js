const urlCsv = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRD5Ys4_DIhIyVhq4LjxbCnUVkmpd7IcAJ4wbHtwUpwG9BZroH6jHXI5I0dHrxQeU0w7mfg0SSTt9Y5/pub?output=csv';
const CLAVE_HASH = 'tareas_ultimo_hash';
const INTERVALO_MS = 60 * 1000; // revisa cada minuto mientras la app está abierta

const esApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

let ultimoPintado = null;   // hash del último CSV dibujado (evita repintar si no hay cambios)
let galerias = [];          // una entrada por fila con imágenes: { titulo, urls }

// Evita que el texto de la hoja pueda inyectar HTML
function escapar(texto) {
    return texto.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hashTexto(texto) {
    let h = 0;
    for (let i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) | 0;
    return String(h);
}

/* ---------- CSV (admite comillas, comas y saltos de línea dentro de una celda) ---------- */
function parsearCsv(texto) {
    const filas = [];
    let fila = [], celda = '', entreComillas = false;
    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];
        if (entreComillas) {
            if (c === '"' && texto[i + 1] === '"') { celda += '"'; i++; }
            else if (c === '"') entreComillas = false;
            else celda += c;
        } else if (c === '"') {
            entreComillas = true;
        } else if (c === ',') {
            fila.push(celda); celda = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && texto[i + 1] === '\n') i++;
            fila.push(celda); celda = '';
            filas.push(fila); fila = [];
        } else {
            celda += c;
        }
    }
    if (celda !== '' || fila.length) { fila.push(celda); filas.push(fila); }
    return filas;
}

/* ---------- Detección de imágenes ---------- */
const EXT_IMAGEN = /\.(png|jpe?g|gif|webp|bmp|avif)(\?[^\s]*)?(#[^\s]*)?$/i;

// Devuelve la URL directa de la imagen, o null si el texto no es una imagen
function aImagen(token) {
    if (!/^https?:\/\/\S+$/i.test(token)) return null;
    // Enlaces de Google Drive -> miniatura grande (el archivo debe estar compartido con "cualquiera con el enlace")
    if (/^https?:\/\/(drive|docs)\.google\.com\//i.test(token)) {
        const m = token.match(/\/file\/d\/([\w-]+)/) || token.match(/[?&]id=([\w-]+)/);
        return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w2000` : null;
    }
    if (EXT_IMAGEN.test(token)) return token;
    if (/^https?:\/\/(i\.imgur\.com|lh\d+\.googleusercontent\.com|images\.unsplash\.com)\//i.test(token)) return token;
    return null;
}

// Una celda es "de imágenes" si todo lo que contiene son enlaces de imagen
function imagenesDeCelda(celda) {
    const partes = celda.trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return [];
    const urls = partes.map(aImagen);
    return urls.every(Boolean) ? urls : [];
}

/* ---------- Categorías, fechas y lista ---------- */
const TIPOS = {
    tarea:  { nombre: 'Tareas',   singular: 'Tarea',   emoji: '📝' },
    examen: { nombre: 'Exámenes', singular: 'Examen',  emoji: '📚' },
    evento: { nombre: 'Eventos',  singular: 'Evento',  emoji: '🎉' }
};
const CLAVE_FILTRO = 'tareas_filtro';
let items = [];
let filtroActual = 'todo';
try { filtroActual = localStorage.getItem(CLAVE_FILTRO) || 'todo'; } catch (e) {}

function normalizar(t) {
    return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Si la celda dice "Tarea", "Examen", "Evento"... devuelve el tipo
function tipoDeCelda(c) {
    const n = normalizar(c);
    if (/^(tarea|tareas|deber|deberes)$/.test(n)) return 'tarea';
    if (/^(examen|examenes|prueba|pruebas|evaluacion|evaluaciones)$/.test(n)) return 'examen';
    if (/^(evento|eventos|actividad|actividades)$/.test(n)) return 'evento';
    return null;
}

// Acepta 25/10/2026, 25-10-26, 2026-10-25 (día/mes/año; si el mes no cabe, lo invierte)
function fechaDeCelda(c) {
    let m = c.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    let d, mes, y;
    if (m) { y = +m[1]; mes = +m[2]; d = +m[3]; }
    else {
        m = c.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
        if (!m) return null;
        d = +m[1]; mes = +m[2]; y = +m[3];
        if (y < 100) y += 2000;
        if (mes > 12 && d <= 12) [d, mes] = [mes, d];
    }
    const f = new Date(y, mes - 1, d);
    return (f.getFullYear() === y && f.getMonth() === mes - 1 && f.getDate() === d) ? f : null;
}

function etiquetaFecha(f) {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const dias = Math.round((f - hoy) / 86400000);
    const texto = f.toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });
    if (dias === 0) return { texto: '⏰ Hoy', clase: 'hoy' };
    if (dias === 1) return { texto: '⏰ Mañana', clase: 'pronto' };
    if (dias < 0)   return { texto: '✔️ ' + texto, clase: 'pasado' };
    return { texto: '📅 ' + texto, clase: dias <= 3 ? 'pronto' : '' };
}

function leerItems(textoCsv) {
    const filas = parsearCsv(textoCsv);
    const lista = [];
    for (let i = 1; i < filas.length; i++) {
        const celdas = filas[i].map(c => c.trim());
        if (celdas.every(c => c === '')) continue;

        let tipo = null, fecha = null;
        const textos = [], urls = [];
        celdas.forEach(c => {
            if (c === '') return;
            const t = tipoDeCelda(c);
            if (t && !tipo) { tipo = t; return; }
            const f = fechaDeCelda(c);
            if (f && !fecha) { fecha = f; return; }
            const imgs = imagenesDeCelda(c);
            if (imgs.length) urls.push(...imgs); else textos.push(c.replace(/\s*\n\s*/g, ' '));
        });
        lista.push({ tipo: tipo || 'tarea', titulo: textos.join(' — '), fecha, urls, orden: i });
    }
    // Primero lo que tiene fecha (la más cercana arriba); después lo que no tiene
    lista.sort((a, b) => {
        if (a.fecha && b.fecha) return a.fecha - b.fecha || a.orden - b.orden;
        if (a.fecha) return -1;
        if (b.fecha) return 1;
        return a.orden - b.orden;
    });
    return lista;
}

function dibujar() {
    const cuenta = { todo: items.length, tarea: 0, examen: 0, evento: 0 };
    items.forEach(it => cuenta[it.tipo]++);
    if (filtroActual !== 'todo' && !TIPOS[filtroActual]) filtroActual = 'todo';

    let html = '<div class="filtros">';
    [['todo', '📋 Todo'], ...Object.entries(TIPOS).map(([k, v]) => [k, `${v.emoji} ${v.nombre}`])].forEach(([k, nombre]) => {
        html += `<button type="button" class="filtro${k === filtroActual ? ' activo' : ''}" data-f="${k}">${nombre} <b>${cuenta[k]}</b></button>`;
    });
    html += '</div>';

    galerias = [];
    const visibles = items.filter(it => filtroActual === 'todo' || it.tipo === filtroActual);
    if (!visibles.length) {
        html += '<p class="vacio">No hay nada en esta categoría.</p>';
    } else {
        html += '<ul>';
        visibles.forEach(it => {
            const t = TIPOS[it.tipo];
            let pasado = false, chip = '';
            if (it.fecha) {
                const e = etiquetaFecha(it.fecha);
                pasado = e.clase === 'pasado';
                chip = `<span class="fecha ${e.clase}">${escapar(e.texto)}</span>`;
            }
            html += `<li class="${it.tipo}${pasado ? ' vencido' : ''}">` +
                `<div class="meta"><span class="etiqueta ${it.tipo}">${t.emoji} ${t.singular}</span>${chip}</div>` +
                `<h2>${escapar(it.titulo)}</h2>`;
            if (it.urls.length) {
                const g = galerias.push({ titulo: it.titulo, urls: it.urls }) - 1;
                html += '<div class="miniaturas">' + it.urls.map((u, n) =>
                    `<button type="button" class="mini" data-g="${g}" data-n="${n}" aria-label="Ver imagen ${n + 1}">` +
                    `<img src="${escapar(u)}" alt="" loading="lazy"></button>`).join('') + '</div>';
            }
            html += '</li>';
        });
        html += '</ul>';
    }
    document.getElementById('contenedor-tareas').innerHTML = html;
}

function pintarTareas(textoCsv) {
    items = leerItems(textoCsv);
    dibujar();
}

document.getElementById('contenedor-tareas').addEventListener('click', e => {
    const f = e.target.closest('.filtro');
    if (f) {
        filtroActual = f.dataset.f;
        try { localStorage.setItem(CLAVE_FILTRO, filtroActual); } catch (err) {}
        dibujar();
    }
});

// Si una miniatura no carga, se oculta y se avisa
document.getElementById('contenedor-tareas').addEventListener('error', e => {
    if (e.target.tagName === 'IMG') {
        const b = e.target.closest('.mini');
        if (b) { b.classList.add('rota'); b.textContent = '🖼️ No se pudo cargar'; }
    }
}, true);

document.getElementById('contenedor-tareas').addEventListener('click', e => {
    const b = e.target.closest('.mini');
    if (b && !b.classList.contains('rota')) abrirVisor(+b.dataset.g, +b.dataset.n);
});

/* ---------- Visor de imágenes con zoom ---------- */
const visor = document.createElement('div');
visor.id = 'visor';
visor.hidden = true;
visor.innerHTML = `
    <div class="visor-barra">
        <div class="visor-titulo"><span id="visor-materia"></span><small id="visor-contador"></small></div>
        <button type="button" id="visor-cerrar" aria-label="Cerrar">✕</button>
    </div>
    <div id="visor-escenario"><img id="visor-img" alt="" draggable="false"></div>
    <p id="visor-error" hidden>No se pudo cargar la imagen.</p>
    <button type="button" id="visor-ant" class="visor-nav" aria-label="Anterior">‹</button>
    <button type="button" id="visor-sig" class="visor-nav" aria-label="Siguiente">›</button>
    <div class="visor-controles">
        <button type="button" id="zoom-menos" aria-label="Alejar">−</button>
        <button type="button" id="zoom-valor" aria-label="Restablecer">100%</button>
        <button type="button" id="zoom-mas" aria-label="Acercar">+</button>
    </div>`;
document.body.appendChild(visor);

const $ = id => document.getElementById(id);
const escenario = $('visor-escenario'), imgVisor = $('visor-img');
const ZOOM_MIN = 1, ZOOM_MAX = 8;
let galActual = null, idxActual = 0;
let escala = 1, tx = 0, ty = 0;
const punteros = new Map();
let distInicial = 0, escalaInicial = 1;
let ultimoToque = 0, ultimoToqueX = 0, ultimoToqueY = 0, movido = false;

function aplicar() {
    // limita el arrastre para que la imagen no se pierda de la pantalla
    const maxX = Math.max(0, (imgVisor.clientWidth * escala - escenario.clientWidth) / 2);
    const maxY = Math.max(0, (imgVisor.clientHeight * escala - escenario.clientHeight) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
    imgVisor.style.transform = `translate(${tx}px, ${ty}px) scale(${escala})`;
    $('zoom-valor').textContent = Math.round(escala * 100) + '%';
}

// Cambia el zoom manteniendo fijo el punto (cx, cy) de la pantalla
function zoomEn(cx, cy, nueva) {
    nueva = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nueva));
    const r = escenario.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    tx = px - (px - tx) * (nueva / escala);
    ty = py - (py - ty) * (nueva / escala);
    escala = nueva;
    if (escala === 1) { tx = 0; ty = 0; }
    aplicar();
}

function centro() {
    const r = escenario.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
}

function reiniciarZoom() { escala = 1; tx = 0; ty = 0; aplicar(); }

function mostrarImagen() {
    const g = galActual;
    $('visor-materia').textContent = g.titulo;
    $('visor-contador').textContent = g.urls.length > 1 ? `Imagen ${idxActual + 1} de ${g.urls.length}` : '';
    const varias = g.urls.length > 1;
    $('visor-ant').hidden = !varias;
    $('visor-sig').hidden = !varias;
    $('visor-error').hidden = true;
    imgVisor.style.visibility = 'hidden';
    reiniciarZoom();
    imgVisor.src = g.urls[idxActual];
}
imgVisor.addEventListener('load', () => { imgVisor.style.visibility = 'visible'; reiniciarZoom(); });
imgVisor.addEventListener('error', () => { $('visor-error').hidden = false; });

function abrirVisor(g, n) {
    galActual = galerias[g]; idxActual = n;
    visor.hidden = false;
    document.body.classList.add('visor-abierto');
    history.pushState({ visor: true }, '');   // el botón "atrás" del móvil cierra el visor
    mostrarImagen();
}

function cerrarVisor(desdeAtras) {
    if (visor.hidden) return;
    visor.hidden = true;
    document.body.classList.remove('visor-abierto');
    imgVisor.removeAttribute('src');
    punteros.clear();
    if (!desdeAtras && history.state && history.state.visor) history.back();
}

function cambiar(d) {
    const total = galActual.urls.length;
    idxActual = (idxActual + d + total) % total;
    mostrarImagen();
}

$('visor-cerrar').addEventListener('click', () => cerrarVisor(false));
$('visor-ant').addEventListener('click', () => cambiar(-1));
$('visor-sig').addEventListener('click', () => cambiar(1));
$('zoom-mas').addEventListener('click', () => zoomEn(...centro(), escala * 1.5));
$('zoom-menos').addEventListener('click', () => zoomEn(...centro(), escala / 1.5));
$('zoom-valor').addEventListener('click', reiniciarZoom);
window.addEventListener('popstate', () => cerrarVisor(true));
window.addEventListener('resize', () => { if (!visor.hidden) aplicar(); });
document.addEventListener('keydown', e => {
    if (visor.hidden) return;
    if (e.key === 'Escape') cerrarVisor(false);
    else if (e.key === 'ArrowLeft' && galActual.urls.length > 1) cambiar(-1);
    else if (e.key === 'ArrowRight' && galActual.urls.length > 1) cambiar(1);
    else if (e.key === '+' || e.key === '=') zoomEn(...centro(), escala * 1.5);
    else if (e.key === '-') zoomEn(...centro(), escala / 1.5);
});

// Rueda del ratón (versión web)
escenario.addEventListener('wheel', e => {
    e.preventDefault();
    zoomEn(e.clientX, e.clientY, escala * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
}, { passive: false });

// Dedo / ratón: arrastrar para mover, pellizcar para zoom, doble toque para acercar
escenario.addEventListener('pointerdown', e => {
    escenario.setPointerCapture(e.pointerId);
    punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movido = false;
    if (punteros.size === 2) {
        const [a, b] = [...punteros.values()];
        distInicial = Math.hypot(a.x - b.x, a.y - b.y);
        escalaInicial = escala;
    }
});

escenario.addEventListener('pointermove', e => {
    const p = punteros.get(e.pointerId);
    if (!p) return;
    if (punteros.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...punteros.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (distInicial > 0) zoomEn((a.x + b.x) / 2, (a.y + b.y) / 2, escalaInicial * dist / distInicial);
        movido = true;
    } else if (punteros.size === 1) {
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) movido = true;
        p.x = e.clientX; p.y = e.clientY;
        if (escala > 1) { tx += dx; ty += dy; aplicar(); }
    }
});

function soltar(e) {
    const habia = punteros.size;
    punteros.delete(e.pointerId);
    if (habia === 1 && !movido && e.type === 'pointerup') {
        const ahora = Date.now();
        if (ahora - ultimoToque < 320 && Math.hypot(e.clientX - ultimoToqueX, e.clientY - ultimoToqueY) < 30) {
            if (escala > 1) reiniciarZoom(); else zoomEn(e.clientX, e.clientY, 2.5);
            ultimoToque = 0;
        } else {
            ultimoToque = ahora; ultimoToqueX = e.clientX; ultimoToqueY = e.clientY;
        }
    }
    if (punteros.size === 1) {            // al soltar un dedo del pellizco, el otro sigue arrastrando
        movido = true;
    }
}
escenario.addEventListener('pointerup', soltar);
escenario.addEventListener('pointercancel', soltar);

/* ---------- Notificaciones y permisos ---------- */
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

        // Solo se repinta si cambió algo (así no parpadean las imágenes cada minuto)
        if (nuevoHash !== ultimoPintado) {
            pintarTareas(textoCsv);
            ultimoPintado = nuevoHash;
        }

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
