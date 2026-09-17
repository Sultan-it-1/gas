const fs = require('fs');
const path = require('path');
const dir = __dirname;

let index = fs.readFileSync(path.join(dir, 'Index.html'), 'utf8');
const styles = fs.readFileSync(path.join(dir, 'Styles.html'), 'utf8');
const scripts = fs.readFileSync(path.join(dir, 'Scripts.html'), 'utf8');

index = index.replace("<?!= include('Styles'); ?>", styles);
index = index.replace("<?!= include('Scripts'); ?>", scripts);

fs.writeFileSync(path.join(dir, 'preview.html'), index, 'utf8');
console.log('preview.html built successfully!');
