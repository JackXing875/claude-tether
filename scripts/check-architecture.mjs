import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const allowed = {
  protocol: [],
  diagnostics: [],
  config: ['protocol'],
  storage: ['protocol'],
  'task-runner': ['protocol'],
  transport: ['protocol'],
  'local-tools': ['protocol', 'task-runner'],
  'operation-journal': ['protocol', 'storage'],
  'local-host': ['protocol', 'local-tools', 'operation-journal'],
  'mcp-bridge': ['protocol'],
  'runtime-adapter': ['protocol', 'config', 'storage', 'runtime-channel'],
  'runtime-channel': ['protocol', 'transport'],
  relay: ['protocol', 'transport', 'runtime-adapter', 'storage'],
  client: ['protocol', 'transport', 'local-host'],
};
const root = resolve('packages');
const errors = [];
const graph = new Map(Object.keys(allowed).map((name) => [name, new Set()]));
for (const file of readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.ts'))) {
  const owner = file.split('/')[0];
  if (!Object.hasOwn(allowed, owner)) {
    errors.push('Declare the dependency boundary for ' + owner);
    continue;
  }
  const absolute = resolve(root, file);
  const source = ts.createSourceFile(
    file,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const check = (specifier) => {
    if (!specifier.startsWith('.')) return;
    const target = relative(root, resolve(dirname(absolute), specifier));
    const dependency = target.split('/')[0];
    if (dependency === owner) return;
    if (!allowed[owner].includes(dependency))
      errors.push(file + ': forbidden dependency on ' + target);
    else graph.get(owner).add(dependency);
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      check(node.moduleSpecifier.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      check(node.argument.literal.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === 'require')
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) check(argument.text);
      else errors.push(file + ': computed imports are not allowed in core packages');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const visit = (name, path = []) => {
  if (path.includes(name)) {
    errors.push('Dependency cycle: ' + [...path, name].join(' -> '));
    return;
  }
  for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name]);
};
for (const name of graph.keys()) visit(name);
if (errors.length) {
  console.error([...new Set(errors)].join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Architecture OK: ' + graph.size + ' core modules; no app imports or dependency cycles.',
  );
