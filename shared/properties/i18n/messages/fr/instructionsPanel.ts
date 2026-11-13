// French `instructionsPanel` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/instructionsPanel';

export const messages = {
  'instructionsPanel.collapseAll': 'Tout réduire',
  'instructionsPanel.conflict.blocked': 'Les deux ont modifié les mêmes lignes ; choisissez une version.',
  'instructionsPanel.conflict.merge': 'Fusionner les deux',
  'instructionsPanel.conflict.mergeTip': 'Conserver les deux modifications',
  'instructionsPanel.conflict.message':
    'Ce fichier a changé sur le disque pendant votre modification. Vos modifications sont conservées ici et ne sont pas enregistrées.',
  'instructionsPanel.conflict.mine': 'Garder la mienne',
  'instructionsPanel.conflict.theirs': 'Utiliser la version du disque',
  'instructionsPanel.docs.empty': 'Aucun autre fichier Markdown dans ce projet.',
  'instructionsPanel.docs.new': 'Nouveau document',
  'instructionsPanel.docs.title': 'Documents',
  'instructionsPanel.expandAll': 'Tout développer',
  'instructionsPanel.form.create': 'Créer',
  'instructionsPanel.form.docPath': 'Chemin du document',
  'instructionsPanel.form.folder': 'Dossier',
  'instructionsPanel.form.folderName': 'Nom du dossier',
  'instructionsPanel.form.projectRoot': 'Racine du projet',
  'instructionsPanel.form.ruleName': 'Nom de la règle',
  'instructionsPanel.form.savedAs': 'Enregistré sous {path}',
  'instructionsPanel.form.skillDescription': 'Description de la skill',
  'instructionsPanel.form.skillName': 'Nom de la skill',
  'instructionsPanel.form.skillNeedsWhen': 'Indiquez quand un agent doit utiliser cette skill.',
  'instructionsPanel.form.skillPlaceholder': 'Ce qu’elle fait, et quand un agent doit l’utiliser',
  'instructionsPanel.hidden': '{pattern} masqué. Réglages → Instructions l’affiche à nouveau.', // review
  'instructionsPanel.menu.copyPath': 'Copier le chemin',
  'instructionsPanel.menu.hideFile': 'Masquer le fichier',
  'instructionsPanel.menu.hideFolder': 'Masquer le dossier',
  'instructionsPanel.menu.reveal': 'Afficher dans le Finder',
  'instructionsPanel.options': 'Options des instructions',
  'instructionsPanel.reading': 'Lecture du projet…',
  'instructionsPanel.refresh': 'Actualiser',
  'instructionsPanel.rowOptions': 'Options de {label}',
  'instructionsPanel.rules.empty':
    'Aucune règle pour l’instant. Ajoutez un AGENTS.md ou un fichier de règles pour dire à l’IA comment ce projet est construit.',
  'instructionsPanel.rules.new': 'Nouvelle règle',
  'instructionsPanel.rules.newFolder': 'Nouveau dossier de règles',
  'instructionsPanel.rules.title': 'Règles',
  'instructionsPanel.skills.empty':
    'Aucune skill pour l’instant. Créez votre première skill pour donner à l’IA le contexte dont elle a besoin pour bien travailler.',
  'instructionsPanel.skills.new': 'Nouvelle skill',
  'instructionsPanel.skills.title': 'Skills', // same
  'instructionsPanel.title': 'Instructions', // same
  'instructionsPanel.truncated':
    'Ce projet contient plus de Markdown que le panneau n’en liste. Masquez des dossiers dans Réglages → Instructions pour voir le reste.',
  'instructionsPanel.view.closeFile': 'Fermer le fichier',
  'instructionsPanel.view.edited': 'Modifié',
  'instructionsPanel.view.fields': 'Champs',
  'instructionsPanel.view.label': 'Vue',
  'instructionsPanel.view.opening': 'Ouverture de {file}…',
  'instructionsPanel.view.readOnly': 'Lecture seule',
  'instructionsPanel.view.region': 'Instructions : {file}',
  'instructionsPanel.view.saved': 'Enregistré',
  'instructionsPanel.view.saving': 'Enregistrement…',
  'instructionsPanel.view.source': 'Source', // same
  'instructionsPanel.problem.skillNameEmpty': 'Donnez un nom à la skill.',
  'instructionsPanel.problem.skillNameLong': 'Le nom d’une skill compte au plus {max} caractères.',
  'instructionsPanel.problem.skillNameFormat': 'Utilisez des minuscules, des chiffres et des tirets simples, comme « write-tests ».',
  'instructionsPanel.problem.fileNameEmpty': 'Donnez-lui un nom.',
  'instructionsPanel.problem.fileNameLong': 'Un nom compte au plus {max} caractères.',
  'instructionsPanel.problem.fileNameChars': 'Un nom ne peut pas contenir / \\ : * ? " < > ni |.',
  'instructionsPanel.problem.fileNameDot': 'Un nom ne peut pas commencer par un point.',
} as const satisfies CatalogOf<MessageKey>;
