// Spanish `welcome` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/welcome';

export const messages = {
  'welcome.clone.busy': 'Descargando…',
  'welcome.clone.downloading': 'Descargando repositorio…',
  'welcome.clone.hint': 'Elige una carpeta a continuación. Stacki descarga una copia local nueva con su historial de Git.',
  'welcome.clone.invalid': 'Escribe un repositorio como propietario/nombre.',
  'welcome.clone.submit': 'Elegir carpeta y descargar',
  'welcome.clone.title': 'Abrir desde GitHub',
  'welcome.creating': 'Creando…',
  'welcome.hero.moreOpen': 'Más formas de abrir un proyecto',
  'welcome.hero.moreStart': 'Más formas de empezar un proyecto',
  'welcome.hero.openFolder': 'Abrir desde carpeta',
  'welcome.hero.openGitHub': 'Abrir desde GitHub',
  'welcome.hero.startAstro': 'Empezar desde Astro',
  'welcome.hero.startLumos': 'Empezar desde Lumos',
  'welcome.packageManager': 'Gestor de paquetes',
  'welcome.project.ai': 'Añadir archivos de agente de IA',
  'welcome.project.git': 'Inicializar un repositorio git nuevo',
  'welcome.project.install': 'Instalar dependencias',
  'welcome.project.question': '¿Cómo quieres empezar tu nuevo proyecto?',
  'welcome.project.starting': 'Iniciando…',
  'welcome.project.submit': 'Crear proyecto',
  'welcome.project.title': 'Nuevo proyecto de Astro',
  'welcome.project.tryAgain': 'Reintentar',
  'welcome.projectCreated': 'Proyecto creado',
  'welcome.recent.remove': 'Quitar de proyectos recientes',
  'welcome.siteCreated': 'Sitio creado',
  'welcome.siteName': 'Nombre del sitio',
  'welcome.starter.note': 'Ejecuta {command} y luego inicia un historial de git propio, así que publicarlo después publica tu sitio, no un fork del starter.',
  'welcome.starter.noteWithManager':
    'Ejecuta {command}, lo instala con {manager} y luego inicia un historial de git propio, así que publicarlo después publica tu sitio, no un fork del starter.',
  'welcome.starter.submit': 'Crear sitio',
  'welcome.starter.title': 'Empezar desde Lumos',
  'welcome.starter.unfinished': 'El starter no terminó.',
  'welcome.template.basics.hint': 'Un proyecto inicial básico y útil',
  'welcome.template.basics.label': 'Básico',
  'welcome.template.blog.hint': 'Colecciones de contenido y rutas de entradas',
  'welcome.template.blog.label': 'Blog', // same
  'welcome.template.minimal.hint': 'Solo lo esencial',
  'welcome.template.minimal.label': 'Vacío',
  'welcome.template.starlight.hint': 'El tema de documentación de Astro',
  'welcome.template.starlight.label': 'Docs (Starlight)', // same
  'welcome.working': 'Trabajando',
} as const satisfies CatalogOf<MessageKey>;
