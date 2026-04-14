const { createApiApp } = require("./app");

const app = createApiApp();
const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`H-L API listening on http://localhost:${port}`);
});
