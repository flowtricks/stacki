// Brazilian Portuguese `welcome` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/welcome';

export const messages = {
  'welcome.clone.busy': 'Baixando…',
  'welcome.clone.downloading': 'Baixando repositório…',
  'welcome.clone.hint': 'Escolha uma pasta em seguida. O Stacki baixa uma nova cópia local com o histórico do Git.',
  'welcome.clone.invalid': 'Informe um repositório como proprietário/nome.',
  'welcome.clone.submit': 'Escolher pasta e baixar',
  'welcome.clone.title': 'Abrir do GitHub',
  'welcome.creating': 'Criando…',
  'welcome.hero.moreOpen': 'Mais formas de abrir um projeto',
  'welcome.hero.moreStart': 'Mais formas de iniciar um projeto',
  'welcome.hero.openFolder': 'Abrir de uma pasta',
  'welcome.hero.openGitHub': 'Abrir do GitHub',
  'welcome.hero.startAstro': 'Começar com Astro',
  'welcome.hero.startLumos': 'Começar com Lumos',
  'welcome.packageManager': 'Gerenciador de pacotes',
  'welcome.project.ai': 'Adicionar arquivos de agente de IA',
  'welcome.project.git': 'Inicializar um novo repositório git',
  'welcome.project.install': 'Instalar dependências',
  'welcome.project.question': 'Como você quer começar seu novo projeto?',
  'welcome.project.starting': 'Iniciando…',
  'welcome.project.submit': 'Criar projeto',
  'welcome.project.title': 'Novo projeto Astro',
  'welcome.project.tryAgain': 'Tentar novamente',
  'welcome.projectCreated': 'Projeto criado',
  'welcome.recent.remove': 'Remover dos projetos recentes',
  'welcome.siteCreated': 'Site criado',
  'welcome.siteName': 'Nome do site',
  'welcome.starter.note': 'Executa {command} e depois inicia um histórico git próprio — assim, publicá-lo depois publica o seu site, não um fork do starter.',
  'welcome.starter.noteWithManager':
    'Executa {command}, instala com {manager} e depois inicia um histórico git próprio — assim, publicá-lo depois publica o seu site, não um fork do starter.',
  'welcome.starter.submit': 'Criar site',
  'welcome.starter.title': 'Começar com Lumos',
  'welcome.starter.unfinished': 'O starter não terminou.',
  'welcome.template.basics.hint': 'Um projeto inicial básico e útil',
  'welcome.template.basics.label': 'Básico',
  'welcome.template.blog.hint': 'Coleções de conteúdo e roteamento de posts',
  'welcome.template.blog.label': 'Blog', // same
  'welcome.template.minimal.hint': 'Só o essencial',
  'welcome.template.minimal.label': 'Vazio',
  'welcome.template.starlight.hint': 'O tema de documentação do Astro',
  'welcome.template.starlight.label': 'Docs (Starlight)', // same
  'welcome.working': 'Em andamento',
} as const satisfies CatalogOf<MessageKey>;
