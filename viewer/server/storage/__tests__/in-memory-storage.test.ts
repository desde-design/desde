import { InMemoryStorage } from "../in-memory-storage"
import { storageAdapterContract } from "./storage-adapter-contract"

storageAdapterContract("in-memory", {
  makeStore: () => new InMemoryStorage(),
})
