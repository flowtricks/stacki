import ts from 'typescript';

interface Binding {
  readonly names: readonly string[];
  readonly statement: string;
  readonly dependencies: ReadonlySet<string>;
}

// Carry only the declarations the subtree needs, recursively. Destination
// bindings win, matching Stacki's reuse of an existing page variable.
export function carriedBindings(source: string, destination: string, names: ReadonlySet<string>) {
  const bindings = readBindings(source);
  const existing = new Set(readBindings(destination).flatMap((binding) => binding.names));
  const byName = new Map(bindings.flatMap((binding) => binding.names.map((name) => [name, binding] as const)));
  const needed = new Set<Binding>();
  const queue = [...names];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const name = queue[index];
    if (!name || visited.has(name) || existing.has(name)) {
      continue;
    }
    visited.add(name);
    const binding = byName.get(name);
    if (!binding) {
      continue;
    }
    if (binding.names.some((declared) => existing.has(declared))) {
      throw new Error(`The copied declaration also defines an existing page binding: ${binding.names.join(', ')}`);
    }
    needed.add(binding);
    queue.push(...binding.dependencies);
  }
  return bindings.filter((binding) => needed.has(binding)).map((binding) => binding.statement);
}

function bindingNames(name: ts.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

function references(node: ts.Node) {
  const names = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child) && !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)) {
      names.add(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

function readBindings(source: string): Binding[] {
  const file = ts.createSourceFile('frontmatter.ts', source, ts.ScriptTarget.Latest, true);
  const bindings: Binding[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      bindings.push(...importBindings(statement, file));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const prefix = statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : statement.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
        bindings.push({
          names: bindingNames(declaration.name),
          statement: `${prefix} ${declaration.getText(file)};`,
          dependencies: references(declaration),
        });
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      bindings.push({
        names: [statement.name.text],
        statement: statement.getText(file),
        dependencies: references(statement),
      });
    }
  }
  return bindings;
}

function importBindings(node: ts.ImportDeclaration, file: ts.SourceFile): Binding[] {
  const clause = node.importClause;
  if (!clause) {
    return [];
  }
  const module = node.moduleSpecifier.getText(file);
  const suffix = node.attributes ? ` ${node.attributes.getText(file)}` : '';
  const type = clause.isTypeOnly ? 'type ' : '';
  const bindings: Binding[] = [];
  const add = (name: string, specifier: string) =>
    bindings.push({
      names: [name],
      statement: `import ${type}${specifier} from ${module}${suffix};`,
      dependencies: new Set<string>(),
    });
  if (clause.name) {
    add(clause.name.text, clause.name.text);
  }
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    add(clause.namedBindings.name.text, clause.namedBindings.getText(file));
  } else if (clause.namedBindings) {
    for (const element of clause.namedBindings.elements) {
      add(element.name.text, `{ ${element.getText(file)} }`);
    }
  }
  return bindings;
}
