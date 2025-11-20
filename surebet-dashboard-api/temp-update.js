import { dbRun } from "./db.js";

const run = async () => {
  await dbRun(
    "UPDATE sheets SET range = 'NOVEMBRO!A4:Z1000' WHERE id = 2"
  );
  console.log("Range atualizado com sucesso!");
  process.exit(0);
};

run();
